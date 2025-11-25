import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { computeCropMap, Constraints, CropKF } from "@/src/services/framingService";
import { renderSmartFramedClip, probeVideo } from "@/src/services/ffmpeg";
import { downloadVideo } from "@/src/services/youtube";
import { uploadFile } from "@/src/services/s3";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const runtime = "nodejs";

function buildPiecewiseExpr(kf: CropKF[], key: "x" | "y"): string {
  if (kf.length === 0) {
    return "0";
  }

  const parts: string[] = [];
  const firstVal = key === "x" ? kf[0].x : kf[0].y;
  parts.push(`lt(t,${kf[0].t.toFixed(3)})*${firstVal.toFixed(0)}`);

  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    const ta = a.t;
    const tb = b.t;
    const va = key === "x" ? a.x : a.y;
    const vb = key === "x" ? b.x : b.y;
    const slope = (vb - va) / Math.max(0.001, tb - ta);
    parts.push(
      `between(t,${ta.toFixed(3)},${tb.toFixed(3)})*(${va.toFixed(0)}+(${slope.toFixed(6)})*(t-${ta.toFixed(3)}))`,
    );
  }

  const lastVal = key === "x" ? kf[kf.length - 1].x : kf[kf.length - 1].y;
  parts.push(`gte(t,${kf[kf.length - 1].t.toFixed(3)})*${lastVal.toFixed(0)}`);

  return parts.join("+");
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const tmp = tmpdir();
  const videoPath = join(tmp, `center-${params.id}-source.mp4`);
  const srtPath = join(tmp, `center-${params.id}.srt`);
  const outputPath = join(tmp, `center-${params.id}-output.mp4`);

  try {
    const clip = await prisma.clip.findUnique({
      where: { id: params.id },
      include: {
        Video: {
          select: { userId: true, sourceUrl: true, id: true },
        },
      },
    });

    if (!clip) {
      return NextResponse.json({ error: "Clip not found" }, { status: 404 });
    }

    if (!clip.Video.sourceUrl) {
      return NextResponse.json(
        { error: "Source video URL not found" },
        { status: 400 },
      );
    }

    console.log(`Centering clip ${clip.id}...`);

    await downloadVideo(clip.Video.sourceUrl, videoPath, clip.Video.userId);
    console.log("Source video downloaded");

    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "auto",
      credentials:
        process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    });

    const srtData = await client.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: clip.s3SrtKey,
      }),
    );

    if (!srtData.Body) {
      throw new Error("Failed to download SRT file");
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of srtData.Body as any) {
      chunks.push(chunk);
    }
    await writeFile(srtPath, Buffer.concat(chunks));
    console.log("SRT file downloaded");

    const probe = await probeVideo(videoPath);
    console.log(`Source video: ${probe.width}x${probe.height}`);

    const targetW = Math.floor((probe.height * 9) / 16);
    const maxPanSpeed = Math.max(200, targetW * 0.4);

    const constraints: Constraints = {
      margin: 0.1,
      maxPan: maxPanSpeed,
      easeMs: 500,
      centerBiasX: 0.3,
      centerBiasY: 0.5,
      safeTop: 0.1,
      safeBottom: 0.1,
    };

    const input = {
      videoPath,
      baseW: probe.width,
      baseH: probe.height,
      segStart: clip.startSec,
      segEnd: clip.endSec,
      transcript: [],
    };

    console.log("Computing crop map...");
    const cropKeyframes: CropKF[] | null = await computeCropMap(
      input,
      constraints,
    );

    if (!cropKeyframes || cropKeyframes.length === 0) {
      return NextResponse.json(
        { error: "Failed to compute crop keyframes - no faces detected" },
        { status: 500 },
      );
    }

    console.log(`Generated ${cropKeyframes.length} crop keyframes`);

    const exprX = buildPiecewiseExpr(cropKeyframes, "x");
    const exprY = buildPiecewiseExpr(cropKeyframes, "y");

    const cropW = cropKeyframes[0].w;
    const cropH = cropKeyframes[0].h;

    console.log("Rendering smart framed clip...");
    await renderSmartFramedClip({
      inputPath: videoPath,
      outputPath,
      startTime: clip.startSec,
      duration: clip.durationSec,
      srtPath,
      hookText: clip.hookText || "",
      cropMapExprX: exprX,
      cropMapExprY: exprY,
      cropW,
      cropH,
    });

    console.log("Uploading to S3...");
    await uploadFile(clip.s3VideoKey, outputPath, "video/mp4");

    console.log("Updating database...");
    await prisma.clip.update({
      where: { id: clip.id },
      data: {
        smartFramed: true,
        cropMapJson: cropKeyframes as any,
      },
    });

    console.log(`Clip ${clip.id} centered successfully`);

    return NextResponse.json({
      success: true,
      message: "Faces centered successfully",
    });
  } catch (error: any) {
    console.error("Error centering video:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 },
    );
  } finally {
    await Promise.all([
      unlink(videoPath).catch(() => {}),
      unlink(srtPath).catch(() => {}),
      unlink(outputPath).catch(() => {}),
    ]);
  }
}
