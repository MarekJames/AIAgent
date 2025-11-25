import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/src/lib/session";
import { prisma } from "@/src/lib/prisma";
import { videoQueue } from "@/src/lib/queue";

export async function DELETE(request: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await request.json().catch(() => ({}) as any);
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x: any) => typeof x === "string")
      : [];

    if (ids.length === 0) {
      return NextResponse.json({ error: "No ids provided" }, { status: 400 });
    }

    const owned = await prisma.video.findMany({
      where: { id: { in: ids }, userId: session.userId },
      select: { id: true },
    });
    const ownedIds = owned.map((v) => v.id);

    if (ownedIds.length === 0) {
      return NextResponse.json(
        { error: "No matching videos found" },
        { status: 404 },
      );
    }

    await Promise.all(
      ownedIds.map(async (id) => {
        const job = await videoQueue.getJob(id);
        if (job) {
          await job.remove();
        }
      }),
    );

    await prisma.$transaction([
      prisma.clip.deleteMany({ where: { videoId: { in: ownedIds } } }),
      prisma.video.deleteMany({
        where: { id: { in: ownedIds }, userId: session.userId },
      }),
    ]);

    return NextResponse.json({ success: true, deleted: ownedIds.length });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete selected videos" },
      { status: 500 },
    );
  }
}
