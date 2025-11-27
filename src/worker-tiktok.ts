import { Worker, Job } from "bullmq";
import { connection } from "@/src/lib/queue";
import { prisma } from "@/src/lib/prisma";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, createWriteStream } from "fs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promises as fsp } from "fs";

import {
  ensureAccessToken,
  initUpload,
  uploadToUrl,
  publishVideo,
} from "@/src/services/tiktok";
import { decrypt, encrypt } from "@/src/lib/encryption";

type TikTokJob = {
  userId: string;
  clipId: string;
  mode: "draft" | "publish";
};

const s3 = new S3Client({
  region: process.env.S3_REGION as string,
  endpoint: process.env.S3_ENDPOINT as string,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  },
  forcePathStyle: true,
});

async function downloadS3ToFile(key: string, outPath: string) {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET as string,
      Key: key,
    })
  );

  const body = obj.Body as any;

  if (!body) {
    throw new Error("S3 body empty");
  }

  const ws = createWriteStream(outPath);

  if (typeof body.pipe === "function") {
    await pipeline(body as Readable, ws);
    return;
  }

  if (typeof body.transformToWebStream === "function") {
    const web = body.transformToWebStream();
    await pipeline(Readable.fromWeb(web as any), ws);
    return;
  }

  if (typeof body.getReader === "function") {
    await pipeline(Readable.fromWeb(body as any), ws);
    return;
  }

  if (typeof body.arrayBuffer === "function") {
    const buf = Buffer.from(await body.arrayBuffer());
    await fsp.writeFile(outPath, buf);
    return;
  }

  throw new Error("Unsupported S3 body type");
}

function buildCaption(
  customTitle: string | null,
  customDescription: string | null,
  fallbackTitle: string | null,
  hook: string | null,
  tags: string[] | null
) {
  if (customTitle || customDescription) {
    const parts = [customTitle, customDescription].filter(Boolean);
    const tagStr = (tags || [])
      .slice(0, 6)
      .map((t) => (t.startsWith("#") ? t : `#${t}`))
      .join(" ");
    const full = [...parts, tagStr].filter(Boolean).join(" ").trim();
    if (full.length <= 200) {
      return full;
    }
    return full.slice(0, 200);
  }
  const base = [hook || "", fallbackTitle || ""]
    .filter(Boolean)
    .join(" · ")
    .trim();
  const tagStr = (tags || [])
    .slice(0, 6)
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
  const full = [base, tagStr].filter(Boolean).join(" ").trim();
  if (full.length <= 200) {
    return full;
  }
  return full.slice(0, 200);
}

async function processTikTok(job: Job<TikTokJob>) {
  const { userId, clipId, mode } = job.data;

  if (!userId) {
    throw new Error("userId is required");
  }

  if (!clipId) {
    throw new Error("clipId is required");
  }

  if (!(mode === "draft" || mode === "publish")) {
    throw new Error("invalid mode");
  }

  const conn = await prisma.tikTokConnection.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });

  if (!conn) {
    throw new Error("tiktok connection not found");
  }

  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    select: {
      id: true,
      s3VideoKey: true,
      rationaleShort: true,
      tags: true,
      tiktokTitle: true,
      tiktokDescription: true,
      Video: { select: { title: true } },
    },
  });

  if (!clip) {
    throw new Error("clip not found");
  }

  if (!clip.s3VideoKey) {
    throw new Error("clip s3VideoKey missing");
  }

  const ensured = await ensureAccessToken({
    accessToken: decrypt(conn.accessToken),
    refreshToken: decrypt(conn.refreshToken),
    expiresAt: conn.expiresAt,
  });

  if (ensured.rotated) {
    await prisma.tikTokConnection.update({
      where: { id: conn.id },
      data: {
        accessToken: encrypt(ensured.accessToken),
        refreshToken: encrypt(ensured.refreshToken),
        expiresAt: ensured.expiresAt,
      },
    });
  }

  const workDir = join(tmpdir(), `tiktok_${clipId}`);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const filePath = join(workDir, "clip.mp4");

  try {
    await downloadS3ToFile(clip.s3VideoKey, filePath);

    const init = await initUpload({
      accessToken: ensured.accessToken,
      filePath,
    });

    await uploadToUrl({
      uploadUrl: init.uploadUrl,
      filePath,
      fileSize: init.fileSize,
      chunkSizeBytes: init.chunkSizeBytes,
      totalChunks: init.totalChunks,
    });

    if (mode === "publish") {
      const caption = buildCaption(
        clip.tiktokTitle || null,
        clip.tiktokDescription || null,
        clip.Video?.title || null,
        clip.rationaleShort || null,
        (clip.tags as string[]) || []
      );

      await publishVideo({
        accessToken: ensured.accessToken,
        publishId: init.publishId,
        caption,
        mode,
      });
    }

    await prisma.clip.update({
      where: { id: clipId },
      data: {
        tiktokPublishId: init.publishId,
        tiktokStatus: mode === "draft" ? "draft" : "published",
      },
    });

    return { publishId: init.publishId };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export const tiktokWorker = new Worker<TikTokJob>(
  "tiktok.post",
  processTikTok,
  {
    connection: connection(),
    concurrency: 2,
    lockDuration: 600000,
    lockRenewTime: 30000,
    maxStalledCount: 1,
  }
);

tiktokWorker.on("completed", (job) => {
  console.log(`tiktok.post ${job.id} completed`);
});

tiktokWorker.on("failed", async (job, err) => {
  if (job?.data?.clipId) {
    await prisma.clip
      .update({
        where: { id: job.data.clipId },
        data: { tiktokStatus: "failed" },
      })
      .catch(() => {});
  }
  console.error(`tiktok.post ${job?.id} failed`, err);
});
