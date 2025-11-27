import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/src/lib/prisma";
import { getSession } from "@/src/lib/session";
import { encrypt } from "@/src/lib/encryption";

const getOAuthClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      `Google OAuth credentials not configured. clientId=${!!clientId}, clientSecret=${!!clientSecret}, redirectUri=${redirectUri}`
    );
  }

  console.log("[GOOGLE CALLBACK] Using redirectUri:", redirectUri);
  return new OAuth2Client(clientId, clientSecret, redirectUri);
};

export async function GET(request: NextRequest) {
  const url = request.nextUrl.toString();
  const origin = request.nextUrl.origin;

  console.log("[GOOGLE CALLBACK] HIT:", url);

  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    console.log("[GOOGLE CALLBACK] Params:", { code, error });

    if (error) {
      console.log("[GOOGLE CALLBACK] Error param from Google:", error);
      return NextResponse.redirect(new URL(`/login?error=${error}`, origin));
    }

    if (!code) {
      console.log("[GOOGLE CALLBACK] Missing code param");
      return NextResponse.redirect(new URL("/login?error=no_code", origin));
    }

    const oauth2Client = getOAuthClient();
    console.log("[GOOGLE CALLBACK] Exchanging code for tokens…");

    const { tokens } = await oauth2Client.getToken(code);

    console.log(
      "[GOOGLE CALLBACK] Tokens received, has access_token:",
      !!tokens.access_token
    );

    if (!tokens.access_token) {
      console.log("[GOOGLE CALLBACK] No access_token in tokens");
      return NextResponse.redirect(new URL("/login?error=no_token", origin));
    }

    oauth2Client.setCredentials(tokens);

    const oauth2 = await oauth2Client.request({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
    });

    const userInfo = oauth2.data as any;

    console.log("[GOOGLE CALLBACK] User info:", {
      email: userInfo?.email,
      id: userInfo?.id,
    });

    if (!userInfo.email || !userInfo.id) {
      console.log("[GOOGLE CALLBACK] Missing email or id in userInfo");
      return NextResponse.redirect(
        new URL("/login?error=no_user_info", origin)
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
      console.log("[GOOGLE CALLBACK] Updating existing user", user.id);
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
      console.log("[GOOGLE CALLBACK] Creating new user");
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

    console.log("[GOOGLE CALLBACK] User logged in:", user.email);

    const session = await getSession();
    session.isAuthenticated = true;
    session.userId = user.id;
    session.email = user.email;
    await session.save();

    console.log("[GOOGLE CALLBACK] Login OK, redirecting to / from", origin);

    return NextResponse.redirect(new URL("/", origin));
  } catch (err: any) {
    console.error("[GOOGLE CALLBACK] ERROR:", err);

    // TEMP: show raw error in browser so we actually see what's wrong
    return NextResponse.json(
      {
        error: "callback_failed",
        message: err?.message || String(err),
        stack: err?.stack,
      },
      { status: 500 }
    );
  }
}
