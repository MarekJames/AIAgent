import { jobManager } from "./jobs";
import { getVideoInfo, downloadVideo, YouTubeAuthError } from "./youtube";
import {
  extractFrames,
  getVideoResolution,
  renderVerticalVideo,
} from "./ffmpeg";
import {
  detectFacesInImage,
  drawDebugFrame,
  type FaceDetection,
} from "./faceDetector";
import type { ProcessMode, CropInfo } from "@shared/schema";
import { promises as fs } from "fs";

export async function processVideo(jobId: string): Promise<void> {
  const job = await jobManager.getJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  try {
    await jobManager.setStatus(jobId, "processing");
    await jobManager.updateProgress(jobId, 0);

    const { url, startSeconds, mode } = job;
    if (!url || startSeconds === undefined || !mode) {
      throw new Error("Missing job parameters");
    }

    const durationSeconds = getModeDuration(mode, startSeconds);

    if (durationSeconds > 7200) {
      throw new Error(
        "Duração excede o limite máximo de 2 horas. Por favor, escolha um intervalo menor.",
      );
    }

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    await jobManager.updateProgress(jobId, 5);
    console.log(`[Job ${jobId}] Downloading video...`);
    const inputPath = jobManager.getInputPath(jobId);
    await downloadVideo(url, inputPath);

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    await jobManager.updateProgress(jobId, 20);
    console.log(`[Job ${jobId}] Getting video resolution...`);
    const resolution = await getVideoResolution(inputPath);

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    await jobManager.updateProgress(jobId, 25);
    console.log(`[Job ${jobId}] Extracting frames...`);

    const fps = getAdaptiveFps(durationSeconds);
    const framesDir = jobManager.getFramesDir();

    const frames = await extractFrames(
      inputPath,
      framesDir,
      startSeconds,
      durationSeconds,
      fps,
      jobId,
      async (percent) => {
        if (!(await jobManager.isJobCancelled(jobId))) {
          await jobManager.updateProgress(jobId, 25 + (percent / 100) * 15);
        }
      },
    );

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    if (frames.length === 0) {
      throw new Error(
        "Não foi possível extrair frames válidos deste vídeo. Verifique se o vídeo está corrompido ou tente outro intervalo.",
      );
    }

    await jobManager.updateProgress(jobId, 40);
    console.log(`[Job ${jobId}] Detecting faces in ${frames.length} frames...`);

    const allDetections: FaceDetection[] = [];
    const framesDetections: FrameDetections[] = [];
    let framesWithFaces = 0;

    // passo entre frames em segundos (aprox)
    const frameStepSeconds =
      frames.length > 1
        ? durationSeconds / (frames.length - 1)
        : durationSeconds;

    for (let i = 0; i < frames.length; i++) {
      if (await jobManager.isJobCancelled(jobId)) {
        await jobManager.cleanupJob(jobId);
        return;
      }

      const framePath = frames[i];
      const currentTime = startSeconds + i * frameStepSeconds;

      const detections = await detectFacesInImage(
        framePath,
        resolution.width,
        resolution.height,
      );

      if (detections.length > 0) {
        const sortedDetections = detections
          // ligeiramente mais tolerante para apanhar o segundo convidado
          .filter((d) => d.score >= 0.3)
          // caras maiores primeiro
          .sort((a, b) => b.width * b.height - a.width * a.height)
          // até 3 caras por frame (host + convidado + eventual extra)
          .slice(0, 3);

        allDetections.push(...sortedDetections);
        framesWithFaces++;

        framesDetections.push({
          index: i,
          time: currentTime,
          detections: sortedDetections,
        });
      } else {
        // guardar frame sem caras – útil para a timeline
        framesDetections.push({
          index: i,
          time: currentTime,
          detections: [],
        });
      }

      const progress = 40 + ((i + 1) / frames.length) * 35;
      await jobManager.updateProgress(jobId, progress);
    }

    await jobManager.setFramesAnalyzed(jobId, frames.length);

    // timeline de centros (Auto Reframe base)
    const centerTimeline = buildCenterTimeline(
      resolution,
      framesDetections,
      startSeconds,
      durationSeconds,
    );
    console.log("[centerTimeline] primeiros 10 pontos:", centerTimeline.slice(0, 10));


    // por enquanto, ainda usamos crop fixo global (calculateCrop antigo)

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    await jobManager.updateProgress(jobId, 75);
    console.log(
      `[Job ${jobId}] Calculating crop (${allDetections.length} faces detected)...`,
    );

    const crop = calculateCrop(resolution, allDetections);
    await jobManager.setCrop(jobId, crop);

    const debugPath = jobManager.getDebugPath(jobId);
    const debugFramePath =
      frames.length > 0 ? frames[Math.floor(frames.length / 2)] : frames[0];

    if (debugFramePath) {
      const debugFrameDetections = await detectFacesInImage(
        debugFramePath,
        resolution.width,
        resolution.height,
      );
      const debugSuccess = await drawDebugFrame(
        debugFramePath,
        debugPath,
        debugFrameDetections,
        crop.cropX,
        crop.cropY,
        crop.cropWidth,
        crop.cropHeight,
      );

      if (debugSuccess) {
        await jobManager.setDebugImagePath(jobId, debugPath);
      } else {
        console.warn(
          `[Job ${jobId}] Debug frame generation failed (non-critical), skipping...`,
        );
      }
    }

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    await jobManager.updateProgress(jobId, 80);
    console.log(`[Job ${jobId}] Rendering vertical video...`);

    const outputPath = jobManager.getOutputPath(jobId);
    await renderVerticalVideo(
      inputPath,
      outputPath,
      startSeconds,
      durationSeconds,
      crop.cropX,
      crop.cropY,
      crop.cropWidth,
      crop.cropHeight,
      async (percent) => {
        if (!(await jobManager.isJobCancelled(jobId))) {
          await jobManager.updateProgress(jobId, 80 + (percent / 100) * 19);
        }
      },
    );

    if (await jobManager.isJobCancelled(jobId)) {
      await jobManager.cleanupJob(jobId);
      return;
    }

    await jobManager.setDownloadPath(jobId, outputPath);
    await jobManager.updateProgress(jobId, 100);
    await jobManager.setStatus(jobId, "done");

    console.log(`[Job ${jobId}] Processing completed successfully`);
  } catch (error: any) {
    console.error(`[Job ${jobId}] Processing error:`, error);

    let errorMessage = error.message || "Erro desconhecido";

    if (error instanceof YouTubeAuthError) {
      errorMessage = error.message;
    }

    await jobManager.setStatus(jobId, "error", errorMessage);
    await jobManager.cleanupJob(jobId);
  }
}

function getModeDuration(mode: ProcessMode, startSeconds: number): number {
  switch (mode) {
    case "3m":
      return 3 * 60;
    case "5m":
      return 5 * 60;
    case "full":
      return 2 * 60 * 60;
    default:
      return 3 * 60;
  }
}

function getAdaptiveFps(durationSeconds: number): number {
  if (durationSeconds <= 600) {
    return 2;
  } else if (durationSeconds <= 3600) {
    return 5;
  } else {
    return 12;
  }
}

interface WeightedValue {
  value: number;
  weight: number;
}

interface FrameDetections {
  index: number; // índice do frame
  time: number; // timestamp em segundos (desde o início do vídeo original)
  detections: FaceDetection[]; // caras nesse frame
}

function weightedMedian(values: WeightedValue[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => {
    if (a.value < b.value) {
      return -1;
    }
    if (a.value > b.value) {
      return 1;
    }
    return 0;
  });

  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const half = totalWeight / 2;

  let acc = 0;
  for (const item of sorted) {
    acc += item.weight;
    if (acc >= half) {
      return item.value;
    }
  }

  return sorted[sorted.length - 1].value;
}

function getFrameCenterX(
  detections: FaceDetection[],
  videoWidth: number,
): number {
  const videoCenterX = videoWidth / 2;

  if (detections.length === 0) {
    return videoCenterX;
  }

  const sorted = [...detections].sort((a, b) => b.area - a.area);

  const top1 = sorted[0];
  const top2 = sorted[1];

  // Se só temos uma cara forte → focamos nessa pessoa
  if (!top2 || top2.area < top1.area * 0.55) {
    return top1.centerX;
  }

  const distance = Math.abs(top2.centerX - top1.centerX);

  // Se as duas caras estão bem separadas → two-shot, centro no meio
  if (distance > videoWidth * 0.25) {
    return (top1.centerX + top2.centerX) / 2;
  }

  // Caso intermédio → focamos na maior
  return top1.centerX;
}

interface CenterKeyframe {
  time: number; // segundos
  centerX: number;
}

function buildCenterTimeline(
  resolution: { width: number; height: number },
  frames: FrameDetections[],
  startSeconds: number,
  durationSeconds: number,
): CenterKeyframe[] {
  const { width: videoWidth } = resolution;
  const videoCenterX = videoWidth / 2;

  if (frames.length === 0) {
    return [
      {
        time: startSeconds,
        centerX: videoCenterX,
      },
    ];
  }

  const raw: CenterKeyframe[] = frames.map((f) => ({
    time: f.time,
    centerX: getFrameCenterX(f.detections, videoWidth),
  }));

  // Pequeno smoothing temporal (janela 3 frames) para evitar saltos bruscos
  const smoothed: CenterKeyframe[] = [];

  for (let i = 0; i < raw.length; i++) {
    let sum = 0;
    let weight = 0;

    for (let j = i - 1; j <= i + 1; j++) {
      if (j < 0 || j >= raw.length) continue;
      const w = j === i ? 2 : 1; // frame atual pesa mais
      sum += raw[j].centerX * w;
      weight += w;
    }

    smoothed.push({
      time: raw[i].time,
      centerX: sum / weight,
    });
  }

  return smoothed;
}

function calculateCrop(
  resolution: { width: number; height: number },
  detections: FaceDetection[],
): CropInfo {
  const { width: videoWidth, height: videoHeight } = resolution;

  // ---- CONFIGURAÇÃO DE FRAMING (fácil de afinar) ----
  const STRONG_MIN_AREA_RATIO = 0.008; // 0.8% da área total do vídeo
  const STRONG_MIN_SCORE = 0.25; // score mínimo para "strong detections"
  const TWO_SPEAKERS_MIN_SIDE_RATIO = 0.18; // min. 18% do peso em cada lado p/ considerar 2 oradores
  const VIDEO_CENTER_BLEND = 0.1; // 10% de mistura com o centro global do vídeo
  const MAX_SHIFT_FROM_CENTER_RATIO = 0.22; // não deixar o crop afastar-se mais que ~22% da largura
  // ---------------------------------------------------

  // 9:16 máximo possível dentro da imagem original
  const maxCropHeight = videoHeight;
  let maxCropWidth = Math.round((maxCropHeight * 9) / 16);

  // Se por algum motivo o vídeo for "estreito", ajustamos a largura
  if (maxCropWidth > videoWidth) {
    maxCropWidth = videoWidth;
  }

  // Se não há deteções, usa crop centrado padrão
  if (detections.length === 0) {
    const centerCropX = Math.max(
      0,
      Math.floor((videoWidth - maxCropWidth) / 2),
    );
    return {
      cropX: centerCropX,
      cropY: 0,
      cropWidth: maxCropWidth,
      cropHeight: maxCropHeight,
      videoWidth,
      videoHeight,
    };
  }

  // 1) Filtrar detecções mais fortes (dar prioridade a planos médios/close-ups)
  const frameArea = videoWidth * videoHeight;
  const strongDetections = detections.filter((d) => {
    return (
      d.score >= STRONG_MIN_SCORE && d.area >= STRONG_MIN_AREA_RATIO * frameArea
    );
  });

  const usedDetections =
    strongDetections.length >= 8 ? strongDetections : detections;

  // 2) Bounding box global do grupo de caras
  let facesLeft = Infinity;
  let facesRight = -Infinity;
  let facesTop = Infinity;
  let facesBottom = -Infinity;

  const centerXValues: WeightedValue[] = [];
  const centerYValues: WeightedValue[] = [];

  for (const d of usedDetections) {
    const right = d.x + d.width;
    const bottom = d.y + d.height;

    if (d.x < facesLeft) facesLeft = d.x;
    if (right > facesRight) facesRight = right;
    if (d.y < facesTop) facesTop = d.y;
    if (bottom > facesBottom) facesBottom = bottom;

    const w = Math.max(d.area, 1);
    centerXValues.push({ value: d.centerX, weight: w });
    centerYValues.push({ value: d.centerY, weight: w });
  }

  const facesWidth = facesRight - facesLeft;
  const facesHeight = facesBottom - facesTop;

  // 3) Detectar se temos 2 oradores bem definidos (esquerda/direita)
  const totalWeight = centerXValues.reduce((sum, v) => sum + v.weight, 0);
  const groupCenterX = (facesLeft + facesRight) / 2;
  const medianCenterX = weightedMedian(centerXValues);

  const leftCluster = centerXValues.filter((v) => v.value <= groupCenterX);
  const rightCluster = centerXValues.filter((v) => v.value > groupCenterX);

  const leftWeight = leftCluster.reduce((sum, v) => sum + v.weight, 0);
  const rightWeight = rightCluster.reduce((sum, v) => sum + v.weight, 0);

  const hasTwoSides =
    totalWeight > 0 &&
    leftWeight / totalWeight >= TWO_SPEAKERS_MIN_SIDE_RATIO &&
    rightWeight / totalWeight >= TWO_SPEAKERS_MIN_SIDE_RATIO;

  let centerFromFaces = medianCenterX;
  let anchorsCenterX = groupCenterX;

  if (hasTwoSides && leftCluster.length > 0 && rightCluster.length > 0) {
    const leftMedian = weightedMedian(leftCluster);
    const rightMedian = weightedMedian(rightCluster);
    anchorsCenterX = (leftMedian + rightMedian) / 2;
    // Centro vindo das caras (entre os dois oradores, mas puxado para onde há mais frames)
    centerFromFaces = anchorsCenterX * 0.8 + medianCenterX * 0.2;
  } else {
    // Um só orador predominante / setup assimétrico
    centerFromFaces = groupCenterX * 0.6 + medianCenterX * 0.4;
  }

  // 4) Misturar um pouco com o centro global do vídeo e limitar o desvio máximo
  const videoCenterX = videoWidth / 2;
  let centerX =
    centerFromFaces * (1 - VIDEO_CENTER_BLEND) +
    videoCenterX * VIDEO_CENTER_BLEND;

  const maxShift = videoWidth * MAX_SHIFT_FROM_CENTER_RATIO;
  const minCenter = videoCenterX - maxShift;
  const maxCenter = videoCenterX + maxShift;

  if (centerX < minCenter) centerX = minCenter;
  if (centerX > maxCenter) centerX = maxCenter;

  // Usamos sempre a altura total -> MENOS zoom possível
  const cropHeight = maxCropHeight;
  const cropWidth = maxCropWidth;

  // Mantemos Y = 0 para não cortar cabeças
  let cropX = Math.round(centerX - cropWidth / 2);
  let cropY = 0;

  // Clamps finais
  if (cropX < 0) cropX = 0;
  if (cropX + cropWidth > videoWidth) cropX = videoWidth - cropWidth;
  if (cropY < 0) cropY = 0;
  if (cropY + cropHeight > videoHeight) cropY = videoHeight - cropHeight;

  console.log("[framing]", {
    totalDetections: detections.length,
    usedDetections: usedDetections.length,
    facesLeft,
    facesRight,
    facesTop,
    facesBottom,
    facesWidth,
    facesHeight,
    totalWeight,
    leftWeight,
    rightWeight,
    hasTwoSides,
    groupCenterX,
    medianCenterX,
    anchorsCenterX,
    centerFromFaces,
    videoCenterX,
    centerX,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    videoWidth,
    videoHeight,
  });

  return {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    videoWidth,
    videoHeight,
  };
}
