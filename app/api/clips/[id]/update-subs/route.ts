import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireAuth } from "@/src/lib/session";
import {
  renderVerticalClip,
  createWordByWordSrtFile,
  createAssWordByWordFile,
} from "@/src/services/ffmpeg";
import { tmpdir } from "os";
import { join } from "path";
import fs from "fs/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { downloadVideo } from "@/src/services/youtube";

const tag = "[update-subs]";
function log(...args: any[]) {
  console.log(tag, ...args);
}
function logErr(...args: any[]) {
  console.error(tag, ...args);
}

function s3() {
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    },
    forcePathStyle: true,
  });
}

async function s3Download(key: string, localPath: string) {
  log("s3Download:start", { key, localPath });
  const t0 = Date.now();
  const client = s3();
  const res = await client.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
  );
  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  await fs.writeFile(localPath, Buffer.concat(chunks));
  log("s3Download:done", { ms: Date.now() - t0 });
}

async function s3Upload(
  localPath: string,
  key: string,
  contentType: string = "video/mp4",
) {
  log("s3Upload:start", { key, localPath, contentType });
  const t0 = Date.now();
  const client = s3();
  const data = await fs.readFile(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
    }),
  );
  log("s3Upload:done", { ms: Date.now() - t0 });
}

function publicUrlForKey(key: string) {
  const base = process.env.PUBLIC_ASSETS_BASE_URL || "";
  return `${base.replace(/\/$/, "")}/${key}`;
}

type W = { word: string; start: number; end: number };

function coerceNumber(v: any): number | undefined {
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function expandUniform(text: string, start: number, end: number): W[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return [];
  }
  const dur = Math.max(0, end - start);
  const step = tokens.length > 0 ? dur / tokens.length : 0;
  const out: W[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const s = start + i * step;
    const e = i === tokens.length - 1 ? end : start + (i + 1) * step;
    out.push({ word: tokens[i], start: s, end: e });
  }
  return out;
}

function normalizeTranscript(raw: any): W[] {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    const segments = raw;
    const words: W[] = [];
    const sample = segments[0]
      ? {
          start: segments[0].start,
          end: segments[0].end,
          hasWords: Array.isArray(segments[0].words),
        }
      : undefined;
    log("transcript:segments:sample", sample);
    for (const seg of segments) {
      const segStart = coerceNumber(seg.start);
      const segEnd = coerceNumber(seg.end);
      if (!Number.isFinite(segStart) || !Number.isFinite(segEnd)) {
        continue;
      }
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        for (const w of seg.words) {
          const ww =
            typeof w.word === "string"
              ? w.word
              : typeof w.text === "string"
                ? w.text
                : "";
          const ws = coerceNumber(w.start);
          const we = coerceNumber(w.end);
          if (ww && Number.isFinite(ws) && Number.isFinite(we)) {
            words.push({
              word: ww.trim(),
              start: ws as number,
              end: we as number,
            });
          }
        }
      } else {
        const text = typeof seg.text === "string" ? seg.text : "";
        const expanded = expandUniform(
          text,
          segStart as number,
          segEnd as number,
        );
        for (const w of expanded) {
          words.push(w);
        }
      }
    }
    return words;
  }
  if (raw && Array.isArray(raw.words)) {
    return raw.words as W[];
  }
  return [];
}

function sliceToClip(
  words: W[],
  startSec: number,
  endSec: number,
  duration: number,
): W[] {
  const a = words
    .filter((w) => {
      if (w.end > startSec && w.start < endSec) {
        return true;
      }
      return false;
    })
    .map((w) => ({
      word: w.word,
      start: Math.max(0, w.start - startSec),
      end: Math.min(duration, w.end - startSec),
    }))
    .filter((w) => {
      if (w.end > w.start) {
        return true;
      }
      return false;
    });
  return a;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const reqId = `${params.id}-${Date.now()}`;
  log("POST:start", { reqId, clipId: params.id });

  try {
    const body = await req.json();
    const rawWords = Number(body.wordsPerSubtitle);
    const wordsPerSubtitle = Number.isFinite(rawWords) ? Math.max(1, Math.min(5, rawWords)) : 1;
    log("request:params", { wordsPerSubtitle });

    const session = await requireAuth();
    log("auth:ok", { userId: session.userId });

    if (!session.userId) {
      logErr("auth:missingUserId");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    log("db:clip:fetch", { id: params.id });
    const clip = await prisma.clip.findUnique({
      where: { id: params.id },
      include: {
        Video: {
          select: { userId: true, sourceUrl: true, id: true, transcript: true },
        },
      },
    });

    if (!clip) {
      logErr("db:clip:notFound", { id: params.id });
      return NextResponse.json({ error: "Clip not found" }, { status: 404 });
    }
    if (clip.Video.userId !== session.userId) {
      logErr("auth:forbidden", {
        owner: clip.Video.userId,
        requester: session.userId,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!clip.s3VideoKey || !clip.s3SrtKey) {
      logErr("clip:missingS3Keys", {
        s3VideoKey: !!clip.s3VideoKey,
        s3SrtKey: !!clip.s3SrtKey,
      });
      return NextResponse.json({ error: "Missing S3 keys" }, { status: 400 });
    }
    if (!clip.Video.sourceUrl) {
      logErr("video:missingSourceUrl");
      return NextResponse.json({ error: "Missing sourceUrl" }, { status: 400 });
    }
    if (!clip.Video.transcript) {
      logErr("video:missingTranscript");
      return NextResponse.json(
        { error: "Missing transcript" },
        { status: 400 },
      );
    }

    const tmp = tmpdir();
    const sourcePath = join(tmp, `${clip.Video.id}-${clip.id}-source.mp4`);
    const assPath = join(tmp, `${clip.id}.ass`);
    const outPath = join(tmp, `${clip.id}-rebuilt.mp4`);
    log("paths", { sourcePath, assPath, outPath });

    const words = normalizeTranscript(clip.Video.transcript);
    log("transcript:words:stats", {
      count: words.length,
      first: words[0],
      last: words[words.length - 1],
    });

    if (words.length === 0) {
      logErr("transcript:words:empty");
      return NextResponse.json(
        { error: "Transcript has no word timings" },
        { status: 400 },
      );
    }

    const clipWords = sliceToClip(
      words,
      clip.startSec,
      clip.endSec,
      clip.durationSec,
    );
    log("srt:words", {
      count: clipWords.length,
      first: clipWords[0],
      last: clipWords[clipWords.length - 1],
    });

    try {
      log("ass:create:start", { wordsPerSubtitle });
      createAssWordByWordFile(clipWords, assPath, wordsPerSubtitle);
      log("ass:create:done");
    } catch (e: any) {
      logErr("ass:create:error", e?.message || e);
      throw new Error("Failed to create ASS");
    }

    try {
      log("downloadVideo:start", { url: clip.Video.sourceUrl });
      await downloadVideo(clip.Video.sourceUrl, sourcePath, session.userId);
      log("downloadVideo:done");
    } catch (e: any) {
      logErr("downloadVideo:error", e?.message || e);
      throw new Error("Failed to download source video");
    }

    try {
      log("render:start", { start: clip.startSec, duration: clip.durationSec });
      await renderVerticalClip({
        inputPath: sourcePath,
        outputPath: outPath,
        startTime: clip.startSec,
        duration: clip.durationSec,
        srtPath: assPath,
      });
      log("render:done");
    } catch (e: any) {
      logErr("render:error", e?.message || e);
      throw new Error("Failed to render vertical clip");
    }

    try {
      log("upload:video:start", { key: clip.s3VideoKey });
      await s3Upload(outPath, clip.s3VideoKey, "video/mp4");
      log("upload:video:done");
    } catch (e: any) {
      logErr("upload:video:error", e?.message || e);
      throw new Error("Failed to upload video");
    }

    try {
      log("upload:ass:start", { key: clip.s3SrtKey });
      await s3Upload(assPath, clip.s3SrtKey, "text/plain");
      log("upload:ass:done");
    } catch (e: any) {
      logErr("upload:ass:error", e?.message || e);
      throw new Error("Failed to upload ass");
    }

    const url = publicUrlForKey(clip.s3VideoKey);
    log("POST:success", { reqId, url });
    return NextResponse.json({ success: true, url });
  } catch (err: any) {
    logErr("POST:error", err?.message || err);
    return NextResponse.json(
      { error: err?.message || "Failed to update subtitles" },
      { status: 500 },
    );
  }
}
