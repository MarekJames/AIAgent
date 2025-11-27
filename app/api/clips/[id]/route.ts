import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireAuth } from "@/src/lib/session";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await requireAuth();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!params?.id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const clip = await prisma.clip.findUnique({
    where: { id: params.id },
    select: { id: true },
  });

  if (!clip) {
    return NextResponse.json({ error: "Clip not found" }, { status: 404 });
  }

  await prisma.clip.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
