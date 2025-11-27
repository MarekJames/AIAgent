import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getCurrentUserId } from "@/src/lib/session";
import { Queue } from "bullmq";
import { connection } from "@/src/lib/queue";

const tiktokQueue = new Queue("tiktok.post", { connection: connection() });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const body = await req.json();
  const mode = body?.mode;
  if (mode !== "draft" && mode !== "publish") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const clip = await prisma.clip.findFirst({
    where: { id: params.id, Video: { userId } },
  });
  if (!clip) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  await tiktokQueue.add("post", { userId, clipId: clip.id, mode });
  return NextResponse.json({ ok: true });
}
