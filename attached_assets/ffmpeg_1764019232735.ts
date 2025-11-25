import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { promises as fs } from "fs";
import path from "path";

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeInstaller.path) {
  ffmpeg.setFfprobePath(ffprobeInstaller.path);
}

export interface VideoResolution {
  width: number;
  height: number;
}

export async function getVideoResolution(videoPath: string): Promise<VideoResolution> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === "video");
      if (!videoStream || !videoStream.width || !videoStream.height) {
        reject(new Error("Could not find video stream dimensions"));
        return;
      }

      resolve({
        width: videoStream.width,
        height: videoStream.height,
      });
    });
  });
}

export async function extractFrames(
  videoPath: string,
  outputDir: string,
  startSeconds: number,
  durationSeconds: number,
  fps: number,
  jobId: string,
  onProgress?: (percent: number) => void
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const pattern = path.join(outputDir, `${jobId}-frame-%04d.png`);

  return new Promise((resolve, reject) => {
    let extractedFrames: string[] = [];

    ffmpeg(videoPath)
      .setStartTime(startSeconds)
      .duration(durationSeconds)
      .outputOptions([
        `-vf fps=1/${fps},scale=640:-1`,
      ])
      .output(pattern)
      .on("end", async () => {
        try {
          const files = await fs.readdir(outputDir);
          extractedFrames = files
            .filter(f => f.startsWith(`${jobId}-frame-`) && f.endsWith(".png"))
            .map(f => path.join(outputDir, f))
            .sort();
          resolve(extractedFrames);
        } catch (err) {
          reject(err);
        }
      })
      .on("error", (err) => {
        reject(err);
      })
      .on("progress", (progress) => {
        if (onProgress && progress.percent) {
          onProgress(progress.percent);
        }
      })
      .run();
  });
}

export async function renderVerticalVideo(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSeconds)
      .duration(durationSeconds)
      .outputOptions([
        `-vf crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=1080:1920`,
        "-c:v libx264",
        "-preset veryfast",
        "-movflags +faststart",
        "-c:a copy",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .on("progress", (progress) => {
        if (onProgress && progress.percent) {
          onProgress(progress.percent);
        }
      })
      .run();
  });
}
