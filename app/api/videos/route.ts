import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireAuth } from "@/src/lib/session";
import { ensureAccessToken } from "@/src/services/tiktok";
import { decrypt } from "@/src/lib/encryption";

function publicUrlForKey(key: string) {
  const base = process.env.PUBLIC_ASSETS_BASE_URL || "";
  if (base) {
    return `${base.replace(/\/$/, "")}/${key}`;
  }
  const endpoint = (process.env.S3_ENDPOINT || "").replace(/\/$/, "");
  const bucket = process.env.S3_BUCKET || "";
  if (endpoint && bucket) {
    return `${endpoint}/${bucket}/${key}`;
  }
  return "";
}

async function fetchTikTokStatus(accessToken: string, publishId: string) {
  const res = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    },
  );
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "10", 10)),
    );
    const skip = (page - 1) * pageSize;

    const [total, videos] = await Promise.all([
      prisma.video.count({ where: { userId: session.userId } }),
      prisma.video.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: { _count: { select: { clips: true } } },
      }),
    ]);

    return NextResponse.json({ total, page, pageSize, videos });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch videos" },
      { status: 500 },
    );
  }
}
