import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/src/lib/prisma";
import { getSession } from "@/src/lib/session";
import { encrypt } from "@/src/lib/encryption";

const getOAuthClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  let redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured");
  }

  console.log("Redirect URI:", redirectUri);
  console.log("Client ID:", clientId);
  console.log("Client Secret:", clientSecret);
  return new OAuth2Client(clientId, clientSecret, redirectUri);
};

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${error}`, request.url),
      );
    }

    if (!code) {
      return NextResponse.redirect(
        new URL("/login?error=no_code", request.url),
      );
    }

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      return NextResponse.redirect(
        new URL("/login?error=no_token", request.url),
      );
    }

    oauth2Client.setCredentials(tokens);

    const oauth2 = await oauth2Client.request({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
    });

    const userInfo = oauth2.data as any;

    if (!userInfo.email || !userInfo.id) {
      return NextResponse.redirect(
        new URL("/login?error=no_user_info", request.url),
      );
    }

    const encryptedAccessToken = tokens.access_token
      ? encrypt(tokens.access_token)
      : null;
    const encryptedRefreshToken = tokens.refresh_token
      ? encrypt(tokens.refresh_token)
      : null;
    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    let user = await prisma.user.findUnique({
      where: { googleAccountId: userInfo.id },
    });

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          email: userInfo.email,
          googleAccessToken: encryptedAccessToken,
          googleRefreshToken: encryptedRefreshToken,
          googleTokenExpiresAt: expiresAt,
        },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email: userInfo.email,
          googleAccountId: userInfo.id,
          googleAccessToken: encryptedAccessToken,
          googleRefreshToken: encryptedRefreshToken,
          googleTokenExpiresAt: expiresAt,
        },
      });
    }

    const session = await getSession();
    session.isAuthenticated = true;
    session.userId = user.id;
    session.email = user.email;
    await session.save();

    const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
    const baseUrl = replitDomain ? `https://${replitDomain}` : request.url;

    return NextResponse.redirect(new URL("/", baseUrl));
  } catch (error: any) {
    console.error("Error in Google OAuth callback:", error);

    const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
    const baseUrl = replitDomain ? `https://${replitDomain}` : request.url;

    return NextResponse.redirect(
      new URL("/login?error=callback_failed", baseUrl),
    );
  }
}
