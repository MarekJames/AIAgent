import { spawn } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getCookieFilePath, cleanupCookieFile } from "./cookieGenerator";

const execPromise = promisify(exec);

type DownloadInfo = {
  file: string;
  height: number;
  fps: number;
  tbr: number;
  vcodec: string;
  acodec: string;
};

function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(err || `exit ${code}`));
      }
    });
  });
}

export async function downloadBest(
  url: string,
  cookieFile?: string
): Promise<DownloadInfo> {
  const outDir = tmpdir();
  const outTpl = join(outDir, "%(id)s.%(ext)s");
  const ytdlp = await findYtDlp();
  const args = [
    "-j",
    "--no-simulate",
    "-f",
    "bv*[height>=720][height<=2160][ext=mp4]+ba[ext=m4a]/bv*[height>=480][height<=2160][ext=mp4]+ba[ext=m4a]/bv*[height<=2160]+ba/b",
    "-S",
    "res,fps,br,codec:h264:av01:vp9",
    "--merge-output-format",
    "mp4",
    "--referer",
    "https://www.youtube.com/",
    "--verbose",
    "-o",
    outTpl,
    url,
  ];
  if (cookieFile && existsSync(cookieFile)) {
    args.splice(1, 0, "--cookies", cookieFile);
    console.log("Using cookie file for authentication");
  } else {
    console.warn(
      "No cookie file available - download may fail for some videos"
    );
  }
  console.log("yt-dlp command:", ytdlp, args.join(" "));
  const { stdout, stderr } = await run(ytdlp, args);
  if (stderr && stderr.length > 0) {
    console.log("yt-dlp stderr:", stderr.substring(0, 2000));
  }
  const lines = stdout.trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  const file = last["_filename"];
  const rf =
    (last["requested_formats"] && last["requested_formats"][0]) || last;
  const height = Number(rf["height"] || 0);
  const fps = Number(rf["fps"] || 0);
  const tbr = Number(rf["tbr"] || 0);
  const vcodec = String(rf["vcodec"] || "");
  const acodec = String(rf["acodec"] || "");
  console.log(`Downloaded: ${height}p ${fps}fps ${vcodec} @ ${tbr}kbps`);
  return { file, height, fps, tbr, vcodec, acodec };
}

export function cleanupUserCookiesFile(userId: string): void {
  console.log("Cookie cleanup no longer needed with OAuth authentication");
}

async function findYtDlp(): Promise<string> {
  if (process.env.YT_DLP_PATH && existsSync(process.env.YT_DLP_PATH)) {
    return process.env.YT_DLP_PATH;
  }

  try {
    await execPromise("which yt-dlp");
    return "yt-dlp";
  } catch {
    try {
      await execPromise("which youtube-dl");
      return "youtube-dl";
    } catch {
      throw new Error("yt-dlp or youtube-dl not found in PATH");
    }
  }
}

export interface Chapter {
  title: string;
  start_time?: number;
  end_time?: number;
  startSec: number;
  endSec: number;
}

interface VideoMetadata {
  id: string;
  title: string;
  duration: number;
  chapters: Chapter[];
}

export async function getVideoMetadata(
  url: string,
  userId: string
): Promise<VideoMetadata> {
  const ytdlp = await findYtDlp();

  const cookieFile = await getCookieFilePath(userId);

  try {
    const args = ["--dump-json", "--no-playlist", url];

    if (cookieFile) {
      args.splice(0, 0, "--cookies", cookieFile);
    }

    const { stdout } = await run(ytdlp, args);
    const metadata = JSON.parse(stdout);

    const chapters = (metadata.chapters || []).map((ch: any) => ({
      title: ch.title,
      start_time: ch.start_time,
      end_time: ch.end_time,
      startSec: ch.start_time,
      endSec: ch.end_time,
    }));

    return {
      id: metadata.id || "",
      title: metadata.title || "Unknown",
      duration: metadata.duration || 0,
      chapters,
    };
  } finally {
    if (cookieFile) {
      await cleanupCookieFile(cookieFile);
    }
  }
}

export async function downloadVideo(
  url: string,
  outputPath: string,
  userId: string
): Promise<DownloadInfo> {
  let info: DownloadInfo | null = null;
  let videoId: string | null = null;
  let cookieFile: string | null = null;

  try {
    cookieFile = await getCookieFilePath(userId);

    const metadata = await getVideoMetadata(url, userId);
    videoId = metadata.id;

    info = await downloadBest(url, cookieFile || undefined);

    if (info.file.length === 0) {
      throw new Error("no file downloaded");
    }

    const { rename } = await import("fs/promises");
    await rename(info.file, outputPath);
    return info;
  } finally {
    if (cookieFile) {
      await cleanupCookieFile(cookieFile);
    }
    if (videoId) {
      cleanupYtDlpTempFiles(videoId);
    }
  }
}

function cleanupYtDlpTempFiles(videoId: string): void {
  const { readdirSync, rmSync } = require("fs");
  const tmp = tmpdir();

  try {
    const files = readdirSync(tmp);
    let cleaned = 0;

    for (const file of files) {
      if (file.startsWith(videoId) && file.match(/\.(webm|mp4|m4a|part)$/)) {
        try {
          rmSync(join(tmp, file), { force: true });
          cleaned++;
        } catch (err) {
          console.error(`Failed to cleanup temp file ${file}:`, err);
        }
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} temp files for video ${videoId}`);
    }
  } catch (err) {
    console.error("Failed to cleanup yt-dlp temp files:", err);
  }
}

export interface YouTubeChapter {
  title: string;
  start_time: number;
  end_time: number;
}

export async function getIntroEndFromChapters(
  url: string,
  cookieFile?: string
): Promise<number | null> {
  try {
    const ytdlp = await findYtDlp();
    const args = ["-J", url];

    if (cookieFile && existsSync(cookieFile)) {
      args.splice(0, 0, "--cookies", cookieFile);
    }

    const { stdout } = await run(ytdlp, args);

    if (!stdout || stdout.trim().startsWith("<")) {
      return null;
    }

    const meta = JSON.parse(stdout);
    const chapters: YouTubeChapter[] = meta.chapters || [];

    if (!chapters.length) {
      return null;
    }

    const first = chapters[0];
    const title = (first.title || "").toLowerCase();

    const looksLikeIntro =
      first.start_time === 0 &&
      (title.includes("intro") ||
        title.includes("introduction") ||
        title.includes("opening") ||
        title.includes("trailer"));

    const maxIntroFraction = 0.3;
    const durationSec = Number(meta.duration || meta.duration_string || 0);
    const isReasonableLength =
      durationSec > 0
        ? first.end_time - first.start_time <= durationSec * maxIntroFraction
        : true;

    if (looksLikeIntro && isReasonableLength) {
      return first.end_time;
    }

    return null;
  } catch (err) {
    console.error("[Chapters] Failed to fetch chapters with yt-dlp:", err);
    return null;
  }
}
