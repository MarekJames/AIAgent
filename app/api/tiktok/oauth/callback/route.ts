import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { encrypt } from "@/src/lib/encryption";
import { getCurrentUserId } from "@/src/lib/session";

function redirectAbs(req: NextRequest, path: string) {
  const xfProto = req.headers.get("x-forwarded-proto") || "https";
  const xfHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const origin = xfHost ? `${xfProto}://${xfHost}` : req.nextUrl.origin;
  return NextResponse.redirect(new URL(path, origin));
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const err = searchParams.get("error");
    if (err) {
      return redirectAbs(req, "/?tiktok=error");
    }
    const code = searchParams.get("code");
    if (!code) {
      return redirectAbs(req, "/?tiktok=error_no_code");
    }

    const body = new URLSearchParams();
    body.set("client_key", process.env.TIKTOK_CLIENT_KEY || "");
    body.set("client_secret", process.env.TIKTOK_CLIENT_SECRET || "");
    body.set("code", code);
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", process.env.TIKTOK_REDIRECT_URI || "");

    const resp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await resp.json();
    if (!resp.ok) {
      return redirectAbs(req, "/?tiktok=error_exchange");
    }

    const userId = await getCurrentUserId();
    if (!userId) {
      return redirectAbs(req, "/login?error=1");
    }

    const accessToken = data?.access_token as string | undefined;
    const refreshToken = data?.refresh_token as string | undefined;
    const openId = data?.open_id as string | undefined;
    const expiresIn = Number(data?.expires_in || 0);
    if (!accessToken || !refreshToken || !openId || !expiresIn) {
      return redirectAbs(req, "/?tiktok=error_payload");
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    await prisma.tikTokConnection.upsert({
      where: { openId },
      update: {
        userId,
        accessToken: encrypt(accessToken),
        refreshToken: encrypt(refreshToken),
        scopes: Array.isArray(data.scope)
          ? data.scope.join(",")
          : data.scope || "",
        expiresAt,
      },
      create: {
        userId,
        openId,
        accessToken: encrypt(accessToken),
        refreshToken: encrypt(refreshToken),
        scopes: Array.isArray(data.scope)
          ? data.scope.join(",")
          : data.scope || "",
        expiresAt,
      },
    });

    return redirectAbs(req, "/?tiktok=connected");
  } catch {
    return redirectAbs(req, "/?tiktok=error_500");
  }
}
