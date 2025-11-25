import { Worker, Job } from "bullmq";
import { connection } from "./lib/queue";
import { prisma } from "./lib/prisma";
import "./worker-tiktok";
import {
  getVideoMetadata,
  downloadVideo,
} from "./services/youtube";
import {
  extractAudio,
  compressAudioForTranscription,
  renderVerticalClip,
  renderSmartFramedClip,
  extractThumbnail,
  createSrtFile,
  createWordByWordSrtFile,
  detectScenes,
  probeBitrate,
  probeVideo,
  createAssWordByWordFile,
} from "./services/ffmpeg";
import { transcribeAudio } from "./services/openai";
import { scoreClip } from "./services/openai";
import { detectSegments } from "./services/segmentation";
import {
  detectEnhancedSegments,
  mineTimestampsFromComments,
} from "./services/segmentation-v2";
import {
  fetchVideoComments,
  extractVideoIdFromUrl,
} from "./services/youtube-comments";
import { uploadFile } from "./services/s3";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { cleanupTempFiles } from "./lib/cleanup";
import { finalizeBestClips } from "./services/selection/finalizeRanking";
import { inferTaxonomy } from "./services/scoring/taxonomy";
import type { RankInput } from "./services/scoring/clipRanker";
import type { EnhancedSegment } from "./services/segmentation-v2";
import {
  computeCropMapPersonStatic,
  buildFFmpegFilter,
  type TranscriptWord as FramingWord,
  type Constraints,
  initializeFaceDetection,
} from "./services/framingService";
import { ensureModelsDownloaded } from "./services/modelDownloader";

interface VideoJob {
  videoId: string;
  userId: string;
}

async function checkCancelled(videoId: string) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { status: true },
  });

  if (video?.status === "cancelled") {
    throw new Error("Video processing was cancelled by user");
  }
}

function buildRankInputsFromEnhanced(
  segmentsWithIds: Array<EnhancedSegment & { clipId: string }>,
  videoId: string,
  aiOverallById: Record<string, number>,
  hotspots: number[],
): RankInput[] {
  return segmentsWithIds.map((e) => {
    const nearHotspot = hotspots.some((h) => Math.abs(h - e.startSec) < 30);
    const rankIn: RankInput = {
      id: e.clipId,
      videoId,
      start: e.startSec,
      end: e.endSec,
      score: e.score,
      pillars: {
        hook: e.features.hookScore,
        watchability: e.features.retentionScore,
        visuals: e.features.visualScore,
        safety: e.features.safetyScore,
        novelty: e.features.noveltyScore,
        coherence: e.features.coherenceScore,
        durationFit: e.features.closureScore,
      },
      aiOverall: aiOverallById[e.clipId] || undefined,
      durationChoice: e.durationChoice,
      nearHotspot,
    };
    return rankIn;
  });
}

async function processVideo(job: Job<VideoJob>) {
  const { videoId, userId } = job.data;

  if (!userId) {
    throw new Error("User ID is required for video processing");
  }

  const existingClips = await prisma.clip.count({
    where: { videoId },
  });

  if (existingClips > 0) {
    console.log(
      `Deleting ${existingClips} existing clips from previous processing attempt`,
    );
    await prisma.clip.deleteMany({
      where: { videoId },
    });
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { user: true },
  });

  if (!video) {
    throw new Error(`Video ${videoId} not found`);
  }

  try {
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "processing" },
    });
  } catch (updateError: any) {
    if (updateError.code === 'P2025') {
      console.log(`Video ${videoId} was deleted before processing could start`);
      throw new Error(`Video ${videoId} not found`);
    }
    throw updateError;
  }

  const workDir = join(tmpdir(), `video_${videoId}`);

  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  try {
    const videoPath = join(workDir, "source.mp4");
    const audioPath = join(workDir, "audio.m4a");
    const transcriptionAudioPath = join(workDir, "audio_transcription.mp3");

    console.log(`Fetching video metadata for chapters`);
    const metadata = await getVideoMetadata(video.sourceUrl, userId);
    console.log(`Found ${metadata.chapters.length} chapters`);

    if (metadata.chapters.length > 0) {
      metadata.chapters.forEach((ch, i) => {
        console.log(
          `  Chapter ${i + 1}: ${ch.title} (${ch.startSec.toFixed(1)}s - ${ch.endSec.toFixed(1)}s)`,
        );
      });
    }

    await checkCancelled(videoId);

    console.log(`Downloading video: ${video.sourceUrl}`);
    const sourceInfo = await downloadVideo(video.sourceUrl, videoPath, userId);
    console.log(
      `Source: ${sourceInfo.height}p ${sourceInfo.fps}fps ${sourceInfo.vcodec} @ ${sourceInfo.tbr}kbps`,
    );

    await checkCancelled(videoId);

    console.log(`Validating source quality`);
    const br = await probeBitrate(videoPath);
    console.log(
      `Measured bitrate: ${br.kbps.toFixed(0)} kbps, size: ${(br.size / 1024 / 1024).toFixed(1)} MB, duration: ${br.seconds.toFixed(1)}s`,
    );

    const minBitrate =
      sourceInfo.height >= 1080 ? 3000 : sourceInfo.height >= 720 ? 1500 : 1000;

    if (br.kbps < minBitrate) {
      console.warn(
        `⚠️  Quality Gate: Source bitrate ${br.kbps.toFixed(0)} kbps is below recommended ${minBitrate} kbps for ${sourceInfo.height}p`,
      );
    } else {
      console.log(
        `✓ Quality Gate: Source quality meets ${sourceInfo.height}p standards (${br.kbps.toFixed(0)} >= ${minBitrate} kbps)`,
      );
    }

    await checkCancelled(videoId);

    console.log(`Extracting audio`);
    await extractAudio(videoPath, audioPath);

    console.log(`Compressing audio for transcription`);
    await compressAudioForTranscription(audioPath, transcriptionAudioPath);

    await checkCancelled(videoId);

    console.log(`Transcribing audio`);
    const transcript = await transcribeAudio(
      transcriptionAudioPath,
      metadata.chapters,
    );

    await checkCancelled(videoId);

    await prisma.video.update({
      where: { id: videoId },
      data: { transcript: transcript as any },
    });

    console.log(`Detecting scene changes`);
    const sceneChanges = await detectScenes(videoPath);
    console.log(`Found ${sceneChanges.length} scene changes`);

    await checkCancelled(videoId);

    let commentHotspots: number[] = [];

    const ytVideoId = extractVideoIdFromUrl(video.sourceUrl);

    if (ytVideoId) {
      console.log(`Fetching YouTube comments for engagement analysis`);
      const comments = await fetchVideoComments(ytVideoId, 100);

      if (comments.length > 0) {
        commentHotspots = mineTimestampsFromComments(comments);
        console.log(
          `Found ${commentHotspots.length} comment hotspots at: ${commentHotspots.map((t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`).join(", ")}`,
        );
      } else {
        console.log(`No comments found, using engagement score defaults`);
      }

      await prisma.video.update({
        where: { id: videoId },
        data: { commentTimestampHotspotsJson: commentHotspots as any },
      });
    } else {
      console.log(`Could not extract video ID, skipping comment fetching`);

      await prisma.video.update({
        where: { id: videoId },
        data: { commentTimestampHotspotsJson: [] as any },
      });
    }

    console.log(`Detecting segments with enhanced v2 algorithm`);
    const segments = detectEnhancedSegments(
      transcript,
      sceneChanges,
      metadata.chapters,
      video.durationSec,
      commentHotspots,
    );

    console.log(`Found ${segments.length} candidate segments`);

    await checkCancelled(videoId);

    console.log(`Stage 1: Filtering with rule-based 7-pillar scores`);
    const sortedByRuleScore = [...segments].sort((a, b) => b.score - a.score);
    const topCandidates = sortedByRuleScore.slice(0, 5);
    console.log(
      `Selected top ${topCandidates.length} candidates for AI scoring (saving ${segments.length - topCandidates.length} GPT-4o calls)`,
    );

    await checkCancelled(videoId);

    console.log(`Stage 2: Scoring top candidates with GPT-4o`);
    const stableTimestamp = Date.now();
    const aiOverallById: Record<string, number> = {};
    const segmentIdMap: Record<string, EnhancedSegment & { clipId: string }> =
      {};

    for (let i = 0; i < segments.length; i++) {
      await checkCancelled(videoId);
      const seg = segments[i];
      const clipId = `clip_${stableTimestamp}_${videoId}_${i}`;
      segmentIdMap[clipId] = { ...seg, clipId };

      const isTopCandidate = topCandidates.includes(seg);
      if (isTopCandidate) {
        try {
          const scores = await scoreClip(video.title, seg.hook, seg.text);
          aiOverallById[clipId] = scores.scores.overall;
          console.log(
            `  Candidate ${topCandidates.indexOf(seg) + 1}/${topCandidates.length}: AI overall score = ${scores.scores.overall}`,
          );
        } catch (err) {
          console.error(
            `  Failed to score candidate ${topCandidates.indexOf(seg) + 1}:`,
            err,
          );
          aiOverallById[clipId] = 50;
        }
      }
    }

    await checkCancelled(videoId);

    console.log(`Ranking and selecting best clips with diversity`);
    const segmentsWithIds = Object.values(segmentIdMap);
    const rankInputs = buildRankInputsFromEnhanced(
      segmentsWithIds,
      videoId,
      aiOverallById,
      commentHotspots,
    );
    const ranked = finalizeBestClips(rankInputs, 5);

    console.log(
      `Selected ${ranked.length} clips: ${ranked.map((r) => `${r.tier}-tier`).join(", ")}`,
    );

    const selectedSegments = ranked.map((r) => ({
      ...segmentIdMap[r.id],
      clipId: r.id,
      tier: r.tier,
      rankScore: r.rankScore,
      reasons: r.reasons,
      aiOverall: aiOverallById[r.id],
    }));

    console.log(`Probing video dimensions for framing`);
    const videoProbe = await probeVideo(videoPath);
    const baseW = videoProbe.width;
    const baseH = videoProbe.height;
    console.log(`Video dimensions: ${baseW}x${baseH}`);

    console.log(`Computing GLOBAL crop for entire video (consistent across all clips)`);
    let globalCrop = null;
    try {
      const { computeGlobalStaticCrop } = await import("./services/framingService");
      globalCrop = await computeGlobalStaticCrop(
        videoPath,
        video.durationSec,
        baseW,
        baseH
      );
      
      if (globalCrop) {
        console.log(`✓ Global crop computed: ${globalCrop.cropW}x${globalCrop.cropH} @ (${globalCrop.cropX},${globalCrop.cropY})`);
        
        await prisma.video.update({
          where: { id: videoId },
          data: { globalCropMapJson: globalCrop },
        });
        console.log(`✓ Stored global crop in database`);
      } else {
        console.log(`⚠️  No persons detected for global crop, will use per-segment framing`);
      }
    } catch (err) {
      console.error(`Failed to compute global crop:`, err);
      console.log(`Will fall back to per-segment framing`);
    }

    const framingConstraints: Constraints = {
      margin: 0.02,
      maxPan: 400,
      easeMs: 600,
      centerBiasX: 0.75,
      centerBiasY: 0.15,
      safeTop: 0.05,
      safeBottom: 0.1,
    };

    const processSegment = async (segment: any, i: number) => {
      await checkCancelled(videoId);

      const clipId = segment.clipId;
      const clipDir = join(workDir, `clip_${i}`);

      if (!existsSync(clipDir)) {
        mkdirSync(clipDir, { recursive: true });
      }

      const clipPath = join(clipDir, "clip.mp4");
      const thumbPath = join(clipDir, "thumb.jpg");
      const assPath = join(clipDir, "clip.ass");

      const adjustedWords = segment.words.map((w: any) => ({
        word: w.word,
        start: w.start - segment.startSec,
        end: w.end - segment.startSec,
      }));

      createAssWordByWordFile(adjustedWords, assPath, 1);

      let cropMap = null;
      let smartFramed = false;

      const framingWords: FramingWord[] = segment.words.map((w: any) => ({
        t: w.start,
        end: w.end,
        text: w.word,
        speaker: w.speaker,
      }));

      console.log(
        `Computing static person-centered framing for clip ${i + 1}/${selectedSegments.length}`,
      );

      try {
        const kf = await computeCropMapPersonStatic(
          {
            videoPath,
            baseW,
            baseH,
            segStart: segment.startSec,
            segEnd: segment.endSec,
            transcript: framingWords,
          },
          framingConstraints,
          globalCrop,
        );

        if (kf && kf.length > 0) {
          smartFramed = true;
          cropMap = kf;
          console.log(
            `✓ Generated ${kf.length} framing keyframes for clip ${i + 1}`,
          );

          const filterExpr = buildFFmpegFilter(baseW, baseH, kf);

          await renderSmartFramedClip({
            inputPath: videoPath,
            outputPath: clipPath,
            startTime: segment.startSec,
            duration: segment.durationSec,
            srtPath: assPath,
            filterExpr,
          });
        } else {
          console.log(
            `⚠️  No persons detected in clip ${i + 1}, using center crop`,
          );
        }
      } catch (err) {
        console.error(
          `Framing failed for clip ${i + 1}, using center crop:`,
          err,
        );
      }

      if (!smartFramed) {
        await renderVerticalClip({
          inputPath: videoPath,
          outputPath: clipPath,
          startTime: segment.startSec,
          duration: segment.durationSec,
          srtPath: assPath,
        });
      }

      const clipBitrate = await probeBitrate(clipPath);

      await checkCancelled(videoId);

      const scores = await scoreClip(video.title, segment.hook, segment.text);
      const taxonomy = inferTaxonomy(
        segment.text,
        segment.hook,
        scores.category,
      );

      await Promise.all([extractThumbnail(clipPath, thumbPath, 1)]);

      await checkCancelled(videoId);

      const s3VideoKey = `videos/${videoId}/clips/${clipId}/clip.mp4`;
      const s3ThumbKey = `videos/${videoId}/clips/${clipId}/thumb.jpg`;
      const s3SrtKey = `videos/${videoId}/clips/${clipId}/clip.srt`;

      await Promise.all([
        uploadFile(s3VideoKey, clipPath, "video/mp4"),
        uploadFile(s3ThumbKey, thumbPath, "image/jpeg"),
        uploadFile(s3SrtKey, assPath, "text/plain"),
      ]);

      await checkCancelled(videoId);

      await prisma.clip.create({
        data: {
          id: clipId,
          videoId,
          startSec: Math.floor(segment.startSec),
          endSec: Math.floor(segment.endSec),
          durationSec: Math.floor(segment.durationSec),
          category: taxonomy.category,
          tags: scores.tags,
          scoreHook: scores.scores.hook_strength,
          scoreRetention: scores.scores.retention_likelihood,
          scoreClarity: scores.scores.clarity,
          scoreShare: scores.scores.shareability,
          scoreOverall: segment.aiOverall || scores.scores.overall,
          rationale: scores.rationale,
          rationaleShort: segment.rationaleShort || scores.rationale,
          featuresJson: segment.features ? (segment.features as any) : null,
          durationChoice: segment.durationChoice || null,
          s3VideoKey,
          s3ThumbKey,
          s3SrtKey,
          smartFramed,
          cropMapJson: cropMap ? (cropMap as any) : null,
        },
      });
    };

    const clipSuccesses: string[] = [];
    const clipFailures: Array<{ index: number; error: any }> = [];

    for (let i = 0; i < selectedSegments.length; i++) {
      await checkCancelled(videoId);

      try {
        await processSegment(selectedSegments[i], i);
        clipSuccesses.push(selectedSegments[i].clipId);
      } catch (err: any) {
        console.error(`Clip ${i + 1} failed:`, err);
        clipFailures.push({ index: i, error: err });

        if (err?.message?.includes("cancelled")) {
          throw err;
        }
      }
    }

    const summary = {
      totalCandidates: segments.length,
      selectedClips: selectedSegments.length,
      successfulClips: clipSuccesses.length,
      failedClips: clipFailures.length,
      tierBreakdown: selectedSegments.reduce(
        (acc, seg) => {
          acc[seg.tier] = (acc[seg.tier] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
      failures: clipFailures.map((f) => ({
        clip: `clip_${f.index}`,
        error: f.error?.message || String(f.error),
      })),
    };

    console.log("Processing summary:", JSON.stringify(summary, null, 2));

    const finalVideo = await prisma.video.findUnique({
      where: { id: videoId },
    });
    if (finalVideo) {
      try {
        await prisma.video.update({
          where: { id: videoId },
          data: { status: "completed" },
        });
      } catch (completedUpdateError: any) {
        if (completedUpdateError.code === 'P2025') {
          console.log(`Video ${videoId} was deleted during completion`);
        } else {
          throw completedUpdateError;
        }
      }
    }

    console.log(
      `Video ${videoId} processing completed with ${clipSuccesses.length} successful clips and ${clipFailures.length} failures`,
    );
  } catch (error: any) {
    console.error(`Error processing video ${videoId}:`, error);

    if (error?.message?.includes("cancelled by user")) {
      console.log(
        `Video ${videoId} was cancelled by user, keeping cancelled status`,
      );
    } else {
      const errorVideo = await prisma.video.findUnique({
        where: { id: videoId },
      });
      if (errorVideo) {
        try {
          await prisma.video.update({
            where: { id: videoId },
            data: { status: "failed" },
          });
        } catch (failedUpdateError: any) {
          if (failedUpdateError.code === 'P2025') {
            console.log(`Video ${videoId} was deleted during error handling`);
            return;
          }
          throw failedUpdateError;
        }
        throw error;
      } else {
        console.log(
          `Video ${videoId} was deleted before processing could complete`,
        );
        return;
      }
    }
  } finally {
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

async function initializeWorker() {
  console.log("Initializing worker...");
  
  try {
    await ensureModelsDownloaded();
    await initializeFaceDetection();
    console.log("Face detection models initialized successfully");
    const { initializeCanvas } = await import("./services/framingService");
    await initializeCanvas();
    console.log("Canvas initialized successfully");
  }
  catch (error) {
    console.error("Failed to initialize worker:", error);
    throw error;
  }

  const worker = new Worker<VideoJob>("video.process", processVideo, {
    connection,
    concurrency: 1,
    lockDuration: 1800000,
    lockRenewTime: 30000,
  });

  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
  });

  cleanupTempFiles();
  console.log("Worker started and ready to process jobs");
}

initializeWorker().catch((error) => {
  console.error("Failed to initialize worker:", error);
  process.exit(1);
});
