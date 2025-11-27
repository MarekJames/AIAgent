import { NextResponse } from "next/server";

export async function GET() {
  const params = new URLSearchParams();
  params.set("client_key", process.env.TIKTOK_CLIENT_KEY || "");
  params.set("response_type", "code");
  params.set("redirect_uri", process.env.TIKTOK_REDIRECT_URI || "");
  params.set("scope", "user.info.basic,video.upload");
  params.set("state", crypto.randomUUID());
  return NextResponse.redirect(
    `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`,
  );
}
