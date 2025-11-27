import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getCurrentUserId } from "@/src/lib/session";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const clip = await prisma.clip.findFirst({
    where: { id: params.id, Video: { userId } },
    select: { tiktokStatus: true, tiktokPublishId: true },
  });
  if (!clip) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  return NextResponse.json({ 
    ok: true, 
    tiktokStatus: clip.tiktokStatus,
    tiktokPublishId: clip.tiktokPublishId
  });
}
