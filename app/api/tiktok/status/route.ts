import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { decrypt } from "@/src/lib/encryption";
import { ensureAccessToken } from "@/src/services/tiktok";

export async function GET(req: NextRequest) {
  try {
    const publishId = req.nextUrl.searchParams.get("publishId");
    if (!publishId) {
      return NextResponse.json(
        { error: "publishId is required" },
        { status: 400 },
      );
    }

    const sessionUserId = req.headers.get("x-user-id"); // or however you identify user
    if (!sessionUserId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const conn = await prisma.tikTokConnection.findFirst({
      where: { userId: sessionUserId },
      orderBy: { updatedAt: "desc" },
    });

    if (!conn) {
      return NextResponse.json(
        { error: "TikTok connection not found" },
        { status: 404 },
      );
    }

    const ensured = await ensureAccessToken({
      accessToken: decrypt(conn.accessToken),
      refreshToken: decrypt(conn.refreshToken),
      expiresAt: conn.expiresAt,
    });

    const res = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ensured.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
      },
    );

    const data = await res.json();

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      data,
    });
  } catch (err: any) {
    console.error("TikTok status check failed", err);
    return NextResponse.json(
      { error: err.message || "Unknown error" },
      { status: 500 },
    );
  }
}
