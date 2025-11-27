import * as tf from "@tensorflow/tfjs-node";
import { detectPersons } from "./detectors";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as faceapi from "@vladmandic/face-api";

const execFileAsync = promisify(execFile);

let canvasInitialized = false;

export async function initializeCanvas(): Promise<void> {
  if (canvasInitialized) {
    return;
  }

  try {
    const { Canvas, Image, ImageData } = await import("canvas");
    faceapi.env.monkeyPatch({
      Canvas: Canvas as any,
      Image: Image as any,
      ImageData: ImageData as any,
    });
    canvasInitialized = true;
  } catch (error) {
    console.error("[Framing] Failed to initialize canvas:", error);
    throw error;
  }
}

export type TranscriptWord = {
  t: number;
  end: number;
  text: string;
  speaker?: string;
};

export interface ComputeInput {
  videoPath: string;
  baseW: number;
  baseH: number;
  segStart: number;
  segEnd: number;
  transcript: TranscriptWord[];
}

export interface Constraints {
  margin: number;
  maxPan: number;
  easeMs: number;
  centerBiasX: number;
  centerBiasY: number;
  safeTop: number;
  safeBottom: number;
}

export type CropKF = {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  xs: number;
  ys: number;
};

type PersonDet = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  id?: number;
  detectorType?: "face" | "pose";
};

type PersonSnapshot = {
  t: number;
  dets: PersonDet[];
};

type Track = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  vx: number;
  vy: number;
  lastT: number;
  age: number;
  hits: number;
  miss: number;
};

type SpeakerTurn = {
  start: number;
  end: number;
  label: string;
};

type SmoothingState = {
  smoothedX: number | null;
  smoothedY: number | null;
};

export interface FaceDetection {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  score: number;
  area: number;
}

interface WeightedValue {
  value: number;
  weight: number;
}

interface FrameDetections {
  index: number;
  time: number;
  detections: FaceDetection[];
}

interface CenterKeyframe {
  time: number;
  centerX: number;
}

interface CropInfo {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  videoWidth: number;
  videoHeight: number;
}

let modelsLoaded = false;

export async function initializeFaceDetection(): Promise<void> {
  if (modelsLoaded) {
    return;
  }

  try {
    const modelsPath = path.join(process.cwd(), "models");

    await fs.promises.mkdir(modelsPath, { recursive: true });

    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsPath);

    modelsLoaded = true;
    console.log("Face detection models loaded successfully");
  } catch (error) {
    console.error("Error loading face detection models:", error);
    throw new Error("Failed to initialize face detection models");
  }
}

export async function detectFacesInImage(
  imagePath: string,
  videoWidth?: number,
  videoHeight?: number
): Promise<FaceDetection[]> {
  if (!modelsLoaded) {
    throw new Error("Face detection models not loaded");
  }

  try {
    await initializeCanvas();
    const { loadImage } = await import("canvas");
    const img = await loadImage(imagePath);

    const frameWidth = img.width;
    const frameHeight = img.height;

    const targetWidth = videoWidth ?? frameWidth;
    const targetHeight = videoHeight ?? frameHeight;

    const scaleX = targetWidth / frameWidth;
    const scaleY = targetHeight / frameHeight;

    const detections = await faceapi.detectAllFaces(
      img as any,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: 512,
        scoreThreshold: 0.2,
      })
    );

    const minWidth = targetWidth * 0.035;
    const minHeight = targetHeight * 0.035;

    const result: FaceDetection[] = [];

    for (const detection of detections) {
      const box = detection.box;

      const rawX = box.x;
      const rawY = box.y;
      const rawW = box.width;
      const rawH = box.height;

      const x = rawX * scaleX;
      const y = rawY * scaleY;
      const width = rawW * scaleX;
      const height = rawH * scaleY;

      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const area = width * height;

      if (width < minWidth || height < minHeight) {
        continue;
      }

      if (centerY < targetHeight * 0.15 || centerY > targetHeight * 0.95) {
        continue;
      }

      result.push({
        x,
        y,
        width,
        height,
        centerX,
        centerY,
        score: detection.score,
        area,
      });
    }

    return result;
  } catch (error: any) {
    const fileName = path.basename(imagePath);
    console.warn(
      `Failed to load or detect faces in frame ${fileName}: ${error.message}`
    );
    return [];
  }
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
  videoWidth: number
): number {
  const videoCenterX = videoWidth / 2;

  if (detections.length === 0) {
    return videoCenterX;
  }

  const sorted = [...detections].sort((a, b) => b.area - a.area);

  const top1 = sorted[0];
  const top2 = sorted[1];

  if (!top2 || top2.area < top1.area * 0.55) {
    return top1.centerX;
  }

  const distance = Math.abs(top2.centerX - top1.centerX);

  if (distance > videoWidth * 0.25) {
    return (top1.centerX + top2.centerX) / 2;
  }

  return top1.centerX;
}

function buildCenterTimeline(
  resolution: { width: number; height: number },
  frames: FrameDetections[],
  startSeconds: number,
  durationSeconds: number
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

  const smoothed: CenterKeyframe[] = [];

  for (let i = 0; i < raw.length; i++) {
    let sum = 0;
    let weight = 0;

    for (let j = i - 1; j <= i + 1; j++) {
      if (j < 0 || j >= raw.length) continue;
      const w = j === i ? 2 : 1;
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
  detections: FaceDetection[]
): CropInfo {
  const { width: videoWidth, height: videoHeight } = resolution;

  const STRONG_MIN_AREA_RATIO = 0.008;
  const STRONG_MIN_SCORE = 0.25;
  const TWO_SPEAKERS_MIN_SIDE_RATIO = 0.18;
  const VIDEO_CENTER_BLEND = 0.1;
  const MAX_SHIFT_FROM_CENTER_RATIO = 0.22;

  const maxCropHeight = videoHeight;
  let maxCropWidth = Math.round((maxCropHeight * 9) / 16);

  if (maxCropWidth > videoWidth) {
    maxCropWidth = videoWidth;
  }

  if (detections.length === 0) {
    const centerCropX = Math.max(
      0,
      Math.floor((videoWidth - maxCropWidth) / 2)
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

  const frameArea = videoWidth * videoHeight;
  const strongDetections = detections.filter((d) => {
    return (
      d.score >= STRONG_MIN_SCORE && d.area >= STRONG_MIN_AREA_RATIO * frameArea
    );
  });

  const usedDetections =
    strongDetections.length >= 8 ? strongDetections : detections;

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
    centerFromFaces = anchorsCenterX * 0.8 + medianCenterX * 0.2;
  } else {
    centerFromFaces = groupCenterX * 0.6 + medianCenterX * 0.4;
  }

  const videoCenterX = videoWidth / 2;
  let centerX =
    centerFromFaces * (1 - VIDEO_CENTER_BLEND) +
    videoCenterX * VIDEO_CENTER_BLEND;

  const maxShift = videoWidth * MAX_SHIFT_FROM_CENTER_RATIO;
  const minCenter = videoCenterX - maxShift;
  const maxCenter = videoCenterX + maxShift;

  if (centerX < minCenter) centerX = minCenter;
  if (centerX > maxCenter) centerX = maxCenter;

  const cropHeight = maxCropHeight;
  const cropWidth = maxCropWidth;

  let cropX = Math.round(centerX - cropWidth / 2);
  let cropY = 0;

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

const DETECT_EVERY = Math.max(1, Number(process.env.PERSON_DETECT_EVERY || 3));
const DEFAULT_SAMPLE_FPS = Math.max(
  1,
  Number(process.env.FRAMING_SAMPLE_FPS || 12)
);
const PERSON_DETECT_WIDTH = Number(process.env.PERSON_DETECT_WIDTH || -1);
const TRACK_IOU_THRESH = Math.max(
  0,
  Math.min(1, Number(process.env.TRACK_IOU_THRESH || 0.35))
);
const TRACK_MAX_AGE_S = Math.max(
  0.1,
  Number(process.env.TRACK_MAX_AGE_S || 0.8)
);
const TRACK_MIN_HITS = Math.max(1, Number(process.env.TRACK_MIN_HITS || 2));
const MIN_TRACK_AREA = Math.max(1, Number(process.env.TRACK_MIN_AREA || 300));
const MIN_DET_AREA = Math.max(1, Number(process.env.MIN_DET_AREA || 100));
const SMOOTH_ALPHA = Math.max(
  0.01,
  Math.min(1, Number(process.env.FRAMING_SMOOTH_ALPHA || 0.2))
);
const DEADZONE_X = Math.max(0, Number(process.env.FRAMING_DEADZONE_X || 70));
const DEADZONE_Y = Math.max(0, Number(process.env.FRAMING_DEADZONE_Y || 50));
const MAX_ACCEL = Math.max(0, Number(process.env.FRAMING_MAX_ACCEL || 900));
const GLOB_LAMBDA_V = Math.max(
  0,
  Number(process.env.FRAMING_GLOB_LAMBDA_V || 80)
);
const GLOB_LAMBDA_A = Math.max(
  0,
  Number(process.env.FRAMING_GLOB_LAMBDA_A || 500)
);
const GLOB_ITERS = Math.max(1, Number(process.env.FRAMING_GLOB_ITERS || 80));
const GLOB_LR = Math.max(0.001, Number(process.env.FRAMING_GLOB_LR || 0.15));
const Z_MIN = Math.max(
  0.8,
  Math.min(1, Number(process.env.FRAMING_Z_MIN || 0.88))
);
const Z_DECAY = Math.max(
  0.01,
  Math.min(1, Number(process.env.FRAMING_Z_DECAY || 0.2))
);

/*export async function computeCropMapPersonStatic(
  input: ComputeInput,
  constraints: Constraints,
  globalCrop?: { cropX: number; cropY: number; cropW: number; cropH: number; zMin: number } | null,
): Promise<CropKF[] | null> {
  if (globalCrop) {
    console.log(
      `[Framing Static] Using GLOBAL crop: ${globalCrop.cropW}x${globalCrop.cropH} @ (${globalCrop.cropX},${globalCrop.cropY})`
    );

    const kf: CropKF = {
      t: input.segStart,
      x: globalCrop.cropX,
      y: globalCrop.cropY,
      w: globalCrop.cropW,
      h: globalCrop.cropH,
      z: globalCrop.zMin,
      xs: 0,
      ys: 0,
    };

    return [kf];
  }

  const snaps = await detectPersonsTimeline(
    input.videoPath,
    input.segStart,
    input.segEnd,
    input.baseW,
    input.baseH,
  );
  if (snaps.length === 0) {
    return null;
  }

  const allCentersX: number[] = [];
  const allCentersY: number[] = [];

  for (const snap of snaps) {
    for (const det of snap.dets) {
      const centerX = det.x + det.w / 2;
      const centerY = det.y + det.h / 2;
      allCentersX.push(centerX);
      allCentersY.push(centerY);
    }
  }

  if (allCentersX.length === 0) {
    return null;
  }

  allCentersX.sort((a, b) => a - b);
  allCentersY.sort((a, b) => a - b);

  const isEvenX = allCentersX.length % 2 === 0;
  const isEvenY = allCentersY.length % 2 === 0;

  const medianX = isEvenX
    ? (allCentersX[allCentersX.length / 2 - 1] + allCentersX[allCentersX.length / 2]) / 2
    : allCentersX[Math.floor(allCentersX.length / 2)];

  const medianY = isEvenY
    ? (allCentersY[allCentersY.length / 2 - 1] + allCentersY[allCentersY.length / 2]) / 2
    : allCentersY[Math.floor(allCentersY.length / 2)];

  const targetW = Math.min(Math.floor((input.baseH * 9) / 16), input.baseW);
  const evenTargetW = Math.floor(targetW / 2) * 2;
  const targetH = input.baseH;
  const zMin = Math.max(evenTargetW / input.baseW, 1.0);

  const cropW = evenTargetW;
  const cropH = targetH;
  
  const idealCropX = Math.round(medianX - cropW / 2);
  const clampedCropX = Math.max(0, Math.min(input.baseW - cropW, idealCropX));
  const cropX = clampedCropX;
  
  const idealCropY = Math.round(medianY - cropH / 2);
  const clampedCropY = Math.max(0, Math.min(input.baseH - cropH, idealCropY));
  const cropY = clampedCropY;

  const personOffsetInCrop = medianX - cropX;
  const centerOffset = cropW / 2;
  const isPersonCentered = Math.abs(personOffsetInCrop - centerOffset) < 10;

  console.log(
    `[Framing Static] Video: ${input.baseW}x${input.baseH}, Crop: ${cropW}x${cropH} @ (${cropX},${cropY})`
  );
  console.log(
    `[Framing Static] Detections: ${allCentersX.length}, Median: (${Math.round(medianX)},${Math.round(medianY)})`
  );
  console.log(
    `[Framing Static] Ideal cropX: ${idealCropX}, Clamped: ${clampedCropX}, Person offset in crop: ${Math.round(personOffsetInCrop)}/${Math.round(centerOffset)} ${isPersonCentered ? '✓ centered' : '✗ OFF-CENTER'}`
  );
  console.log(
    `[Framing Static] z_min: ${zMin.toFixed(2)}, Crop range: X[${cropX}-${cropX + cropW}] Y[${cropY}-${cropY + cropH}]`
  );

  const kf: CropKF = {
    t: input.segStart,
    x: cropX,
    y: cropY,
    w: evenTargetW,
    h: targetH,
    z: zMin,
    xs: 0,
    ys: 0,
  };

  return [kf];
}*/
export async function computeCropMapPersonStatic(
  input: ComputeInput,
  constraints: Constraints,
  globalCrop?: {
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
    zMin: number;
  } | null
): Promise<CropKF[] | null> {
  if (globalCrop) {
    console.log(
      `[Framing Static] Using GLOBAL crop: ${globalCrop.cropW}x${globalCrop.cropH} @ (${globalCrop.cropX},${globalCrop.cropY})`
    );

    const kf: CropKF = {
      t: input.segStart,
      x: globalCrop.cropX,
      y: globalCrop.cropY,
      w: globalCrop.cropW,
      h: globalCrop.cropH,
      z: globalCrop.zMin,
      xs: 0,
      ys: 0,
    };

    return [kf];
  }

  const snaps = await detectPersonsTimeline(
    input.videoPath,
    input.segStart,
    input.segEnd,
    input.baseW,
    input.baseH
  );

  if (snaps.length === 0) {
    return null;
  }

  const rawTargetW = Math.min(Math.floor((input.baseH * 9) / 16), input.baseW);
  const targetW = Math.floor(rawTargetW / 2) * 2;
  const evenTargetW = targetW;
  const maxAnchorWidth = targetW * 0.9;

  const anchorCentersX: number[] = [];
  const anchorCentersY: number[] = [];
  const anchorWidths: number[] = [];
  const anchorHeights: number[] = [];
  const pairedAnchors: { x: number; y: number; w: number; h: number }[] = [];

  for (const snap of snaps) {
    if (snap.dets.length === 0) {
      continue;
    }

    const anchor = chooseAnchor(snap.dets, input.baseW, input.baseH);
    const effectiveW = Math.min(anchor.w, maxAnchorWidth);
    const cx = anchor.x + anchor.w / 2;
    const cy = anchor.y + anchor.h / 2;
    anchorCentersX.push(cx);
    anchorCentersY.push(cy);
    anchorWidths.push(effectiveW);
    anchorHeights.push(anchor.h);
    pairedAnchors.push({
      x: anchor.x,
      y: anchor.y,
      w: effectiveW,
      h: anchor.h,
    });
  }

  if (anchorCentersX.length === 0) {
    return null;
  }

  anchorCentersX.sort((a, b) => a - b);
  anchorCentersY.sort((a, b) => a - b);
  anchorWidths.sort((a, b) => a - b);
  anchorHeights.sort((a, b) => a - b);

  const medianCx = median(anchorCentersX);
  const medianCy = median(anchorCentersY);
  const p90Width = percentile(anchorWidths, 90);
  const p90Height = percentile(anchorHeights, 90);
  const zMinWidth = evenTargetW / input.baseW;
  const zMinHeight = 1.0;
  const zMin = Math.max(zMinWidth, zMinHeight, 0.88);

  const frameCenterX = input.baseW / 2;
  const direction = Math.sign(medianCx - frameCenterX);
  //alterar aqui
  const bias = evenTargetW * 0.35;

  let biasedCenterX = medianCx;

  if (direction !== 0) {
    biasedCenterX = medianCx - direction * bias;
  }

  let cropXFinal = Math.round(biasedCenterX - evenTargetW / 2);
  const maxX = input.baseW - evenTargetW;

  if (cropXFinal < 0) {
    cropXFinal = 0;
  }

  if (cropXFinal > maxX) {
    cropXFinal = maxX;
  }

  console.log(
    `[Framing Static] Segment framing: ${
      anchorCentersX.length
    } anchors, targetW: ${targetW}, medianCx: ${Math.round(
      medianCx
    )}, biasedCenterX: ${Math.round(
      biasedCenterX
    )}, cropXFinal: ${cropXFinal}, z: ${zMin.toFixed(2)}`
  );

  const kf: CropKF = {
    t: input.segStart,
    x: cropXFinal,
    y: 0,
    w: evenTargetW,
    h: input.baseH,
    z: zMin,
    xs: 0,
    ys: 0,
  };

  return [kf];
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.ceil((sortedValues.length * p) / 100) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const isEven = sortedValues.length % 2 === 0;
  if (isEven) {
    return (
      (sortedValues[sortedValues.length / 2 - 1] +
        sortedValues[sortedValues.length / 2]) /
      2
    );
  }
  return sortedValues[Math.floor(sortedValues.length / 2)];
}

async function detectFacesTimeline(
  videoPath: string,
  resolution: { width: number; height: number },
  startTime: number,
  duration: number,
  fps: number = DEFAULT_SAMPLE_FPS
): Promise<FrameDetections[]> {
  const expectedFrames = Math.ceil(duration * fps);
  const tempDir = path.join(process.cwd(), "tmp", `faces_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await extractFrames(videoPath, startTime, duration, fps, tempDir);
    const frameFiles = fs
      .readdirSync(tempDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    const out: FrameDetections[] = [];
    const frameInterval = 1 / fps;

    for (let i = 0; i < frameFiles.length && i < expectedFrames; i++) {
      const framePath = path.join(tempDir, frameFiles[i]);
      const t = startTime + i * frameInterval;

      try {
        const detections = await detectFacesInImage(
          framePath,
          resolution.width,
          resolution.height
        );
        const scoreFiltered = detections.filter((d) => d.score >= 0.3);

        if (scoreFiltered.length > 0) {
          console.log(
            `[Face Detection] Frame ${i}: Found ${
              scoreFiltered.length
            } faces (score ≥ 0.3), avg confidence: ${(
              scoreFiltered.reduce((s, d) => s + d.score, 0) /
              scoreFiltered.length
            ).toFixed(3)}`
          );
        }

        out.push({
          index: i,
          time: t,
          detections: scoreFiltered,
        });
      } catch (err) {
        console.warn(`[Face Detection] Frame ${i}: Detection failed - ${err}`);
        out.push({
          index: i,
          time: t,
          detections: [],
        });
      }
    }

    return out;
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function isAnchorFullyInside(
  anchorX: number,
  anchorY: number,
  anchorW: number,
  anchorH: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
  margin: number
): boolean {
  const anchorLeft = anchorX;
  const anchorRight = anchorX + anchorW;
  const anchorTop = anchorY;
  const anchorBottom = anchorY + anchorH;

  const cropLeft = cropX + margin;
  const cropRight = cropX + cropW - margin;
  const cropTop = cropY + margin;
  const cropBottom = cropY + cropH - margin;

  return (
    anchorLeft >= cropLeft &&
    anchorRight <= cropRight &&
    anchorTop >= cropTop &&
    anchorBottom <= cropBottom
  );
}

export async function computeGlobalStaticCrop(
  videoPath: string,
  videoDurationSec: number,
  baseW: number,
  baseH: number,
  options?: { skipUntilSec?: number }
): Promise<{
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  zMin: number;
} | null> {
  await initializeFaceDetection();

  const sampleDurationSec = 15;
  const maxSamples = 6;

  const skipUntil = Math.max(0, options?.skipUntilSec ?? 0);

  const defaultStart = videoDurationSec * 0.1;
  const defaultEnd = videoDurationSec * 0.9;

  let usableStart = Math.max(skipUntil, defaultStart);
  let usableEnd = defaultEnd;

  if (usableStart > videoDurationSec - sampleDurationSec) {
    usableStart = Math.max(0, videoDurationSec - sampleDurationSec);
  }

  if (usableEnd < usableStart + sampleDurationSec) {
    usableEnd = Math.min(videoDurationSec, usableStart + sampleDurationSec);
  }

  const usableDuration = Math.max(sampleDurationSec, usableEnd - usableStart);

  const numSamples = Math.min(
    maxSamples,
    Math.max(3, Math.floor(usableDuration / sampleDurationSec))
  );

  const rawTargetW = Math.min(Math.floor((baseH * 9) / 16), baseW);
  const targetW = Math.floor(rawTargetW / 2) * 2;

  const allDetections: FaceDetection[] = [];
  let successfulSamples = 0;
  let failedSamples = 0;

  console.log(
    `[Global Crop] Sampling ${numSamples} intervals (${sampleDurationSec}s each) between ${usableStart.toFixed(
      1
    )}s and ${usableEnd.toFixed(1)}s using TinyFaceDetector`
  );

  for (let i = 0; i < numSamples; i++) {
    const t =
      numSamples === 1
        ? usableStart + (usableDuration - sampleDurationSec) / 2
        : usableStart +
          (i * (usableDuration - sampleDurationSec)) / (numSamples - 1);

    const sampleStart = Math.max(
      0,
      Math.min(t, videoDurationSec - sampleDurationSec)
    );
    const sampleEnd = Math.min(
      sampleStart + sampleDurationSec,
      videoDurationSec
    );
    const beforeCount = allDetections.length;

    try {
      const frames = await detectFacesTimeline(
        videoPath,
        { width: baseW, height: baseH },
        sampleStart,
        Math.min(sampleEnd - sampleStart, sampleDurationSec),
        DEFAULT_SAMPLE_FPS
      );

      for (const frame of frames) {
        for (const det of frame.detections) {
          allDetections.push(det);
        }
      }

      const detectionsInSample = allDetections.length - beforeCount;
      if (detectionsInSample > 0) {
        console.log(
          `[Global Crop] Sample ${
            i + 1
          }/${numSamples} @ ${sampleStart}s-${sampleEnd}s: ${detectionsInSample} faces ✓`
        );
        successfulSamples++;
      } else {
        console.log(
          `[Global Crop] Sample ${
            i + 1
          }/${numSamples} @ ${sampleStart}s-${sampleEnd}s: 0 faces`
        );
        failedSamples++;
      }
    } catch (err) {
      console.error(
        `[Global Crop] Sample ${
          i + 1
        }/${numSamples} @ ${sampleStart}s-${sampleEnd}s: ERROR - ${err}`
      );
      failedSamples++;
    }
  }

  const minDetectionsRequired = 50;
  if (allDetections.length < minDetectionsRequired) {
    console.log(
      `[Global Crop] Insufficient faces: ${allDetections.length} found, ${minDetectionsRequired} required (${successfulSamples} successful samples)`
    );
    return null;
  }

  console.log(
    `[Global Crop] Aggregated ${allDetections.length} face detections, using two-speaker-aware crop calculation`
  );

  const cropResult = calculateCrop(
    { width: baseW, height: baseH },
    allDetections
  );

  const finalCropW = Math.floor(cropResult.cropWidth / 2) * 2;
  const zMinWidth = finalCropW / baseW;
  const zMinHeight = 1.0;
  const zMin = Math.max(zMinWidth, zMinHeight, 0.88);

  return {
    cropX: cropResult.cropX,
    cropY: cropResult.cropY,
    cropW: finalCropW,
    cropH: cropResult.cropHeight,
    zMin,
  };
}

/*
export async function computeGlobalStaticCrop(
  videoPath: string,
  videoDurationSec: number,
  baseW: number,
  baseH: number,
): Promise<{ cropX: number; cropY: number; cropW: number; cropH: number; zMin: number } | null> {
  const sampleIntervalSec = 30;
  const sampleDurationSec = 15;
  const numSamples = Math.max(3, Math.floor(videoDurationSec / sampleIntervalSec));
  
  const allCentersX: number[] = [];
  const allCentersY: number[] = [];
  
  let successfulSamples = 0;
  let failedSamples = 0;

  console.log(`[Global Crop] Sampling ${numSamples} intervals (${sampleDurationSec}s each) across ${videoDurationSec}s video`);

  for (let i = 0; i < numSamples; i++) {
    const sampleStart = Math.floor((i * videoDurationSec) / numSamples);
    const sampleEnd = Math.min(sampleStart + sampleDurationSec, videoDurationSec);
    
    const beforeCount = allCentersX.length;
    
    try {
      const snaps = await detectPersonsTimeline(
        videoPath,
        sampleStart,
        sampleEnd,
        baseW,
        baseH,
      );

      for (const snap of snaps) {
        for (const det of snap.dets) {
          const centerX = det.x + det.w / 2;
          const centerY = det.y + det.h / 2;
          allCentersX.push(centerX);
          allCentersY.push(centerY);
        }
      }
      
      const detectionsInSample = allCentersX.length - beforeCount;
      if (detectionsInSample > 0) {
        console.log(`[Global Crop] Sample ${i + 1}/${numSamples} @ ${sampleStart}s-${sampleEnd}s: ${detectionsInSample} detections ✓`);
        successfulSamples++;
      } else {
        console.log(`[Global Crop] Sample ${i + 1}/${numSamples} @ ${sampleStart}s-${sampleEnd}s: 0 detections (person may be off-screen)`);
        failedSamples++;
      }
    } catch (err) {
      console.error(`[Global Crop] Sample ${i + 1}/${numSamples} @ ${sampleStart}s-${sampleEnd}s: ERROR - ${err}`);
      failedSamples++;
    }
  }

  const minDetectionsRequired = 50;
  
  if (allCentersX.length < minDetectionsRequired) {
    console.log(`[Global Crop] Insufficient detections: ${allCentersX.length} found, ${minDetectionsRequired} required (${successfulSamples} successful samples, ${failedSamples} failed)`);
    return null;
  }
  
  console.log(`[Global Crop] Aggregated ${allCentersX.length} detections from ${successfulSamples}/${numSamples} successful samples`);

  if (allCentersX.length === 0) {
    console.log(`[Global Crop] No detections found across video`);
    return null;
  }

  allCentersX.sort((a, b) => a - b);
  allCentersY.sort((a, b) => a - b);

  const isEvenX = allCentersX.length % 2 === 0;
  const isEvenY = allCentersY.length % 2 === 0;

  const medianX = isEvenX
    ? (allCentersX[allCentersX.length / 2 - 1] + allCentersX[allCentersX.length / 2]) / 2
    : allCentersX[Math.floor(allCentersX.length / 2)];

  const medianY = isEvenY
    ? (allCentersY[allCentersY.length / 2 - 1] + allCentersY[allCentersY.length / 2]) / 2
    : allCentersY[Math.floor(allCentersY.length / 2)];

  const targetW = Math.min(Math.floor((baseH * 9) / 16), baseW);
  const evenTargetW = Math.floor(targetW / 2) * 2;
  const targetH = baseH;
  const zMin = Math.max(evenTargetW / baseW, 1.0);

  const cropW = evenTargetW;
  const cropH = targetH;
  
  const idealCropX = Math.round(medianX - cropW / 2);
  const clampedCropX = Math.max(0, Math.min(baseW - cropW, idealCropX));
  const cropX = clampedCropX;
  
  const idealCropY = Math.round(medianY - cropH / 2);
  const clampedCropY = Math.max(0, Math.min(baseH - cropH, idealCropY));
  const cropY = clampedCropY;

  console.log(
    `[Global Crop] Analyzed ${allCentersX.length} detections from ${numSamples} samples`
  );
  console.log(
    `[Global Crop] Median: (${Math.round(medianX)},${Math.round(medianY)}), Crop: ${cropW}x${cropH} @ (${cropX},${cropY})`
  );

  return {
    cropX,
    cropY,
    cropW,
    cropH,
    zMin,
  };
}
*/
export async function computeCropMapPerson(
  input: ComputeInput,
  constraints: Constraints
): Promise<CropKF[] | null> {
  const snaps = await detectPersonsTimeline(
    input.videoPath,
    input.segStart,
    input.segEnd,
    input.baseW,
    input.baseH
  );
  if (snaps.length === 0) {
    return null;
  }
  const tracksTimeline = buildTracks(snaps, input.baseW, input.baseH);
  if (tracksTimeline.length === 0) {
    return null;
  }
  const turns = buildSpeakerTurns(
    input.transcript,
    input.segStart,
    input.segEnd
  );
  const raw = computeGlobalCropKeyframesFromTracksWithSpeechAndZoom(
    tracksTimeline,
    turns,
    input.baseW,
    input.baseH,
    constraints
  );
  if (raw.length === 0) {
    return null;
  }
  const smoothed = smoothKeyframes(raw);
  const deadzoned = applyDeadzone(smoothed, DEADZONE_X, DEADZONE_Y);
  const limited = applyPanLimits(deadzoned, constraints.maxPan);
  const accelLimited = applyAccelLimits(limited, MAX_ACCEL);
  const eased = easeSegmentEdges(
    accelLimited,
    input.segStart,
    input.segEnd,
    constraints.easeMs / 1000
  );
  const withScaled = applyScaledCoords(eased, input.baseW, input.baseH);
  const deduped = withScaled.length > 0 ? dedupeByTime(withScaled, 0.1) : [];

  if (deduped.length === 0) {
    return null;
  }

  const compressed = compressCropMap(deduped, 120);
  const duration = deduped[deduped.length - 1].t - deduped[0].t;
  console.log(
    `[Framing] Keyframe compression: ${deduped.length} → ${
      compressed.length
    } (${((1 - compressed.length / deduped.length) * 100).toFixed(
      1
    )}% reduction, 1 KF every ${(duration / compressed.length).toFixed(1)}s)`
  );

  return compressed;
}

export function buildPiecewiseExpr(
  kf: CropKF[],
  key: "x" | "y" | "xs" | "ys"
): string {
  if (kf.length === 0) {
    return "0";
  }

  const values = kf.map((k) => {
    return key === "x" ? k.x : key === "y" ? k.y : key === "xs" ? k.xs : k.ys;
  });

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const isConstant = maxVal - minVal < 1;

  if (isConstant) {
    return String(Math.round(values[0]));
  }

  const parts: string[] = [];
  const first = values[0];
  parts.push(`lt(t,${kf[0].t.toFixed(3)})*${Math.round(first)}`);
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    const ta = a.t;
    const tb = b.t;
    const va = values[i];
    const vb = values[i + 1];
    const slope = (vb - va) / Math.max(0.001, tb - ta);
    parts.push(
      `between(t,${ta.toFixed(3)},${tb.toFixed(3)})*(${Math.round(
        va
      )}+(${slope.toFixed(6)})*(t-${ta.toFixed(3)}))`
    );
  }
  const last = values[values.length - 1];
  parts.push(`gte(t,${kf[kf.length - 1].t.toFixed(3)})*${Math.round(last)}`);
  return parts.join("+");
}

export function buildPiecewiseExprZ(kf: CropKF[]): string {
  if (kf.length === 0) {
    return "1";
  }

  const zValues = kf.map((k) => {
    return k.z;
  });
  const minZ = Math.min(...zValues);
  const maxZ = Math.max(...zValues);
  const isConstant = maxZ - minZ < 0.001;

  if (isConstant) {
    return zValues[0].toFixed(4);
  }

  const parts: string[] = [];
  parts.push(`lt(t,${kf[0].t.toFixed(3)})*${kf[0].z.toFixed(4)}`);
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    const ta = a.t;
    const tb = b.t;
    const slope = (b.z - a.z) / Math.max(0.001, tb - ta);
    parts.push(
      `between(t,${ta.toFixed(3)},${tb.toFixed(3)})*(${a.z.toFixed(
        4
      )}+(${slope.toFixed(6)})*(t-${ta.toFixed(3)}))`
    );
  }
  parts.push(
    `gte(t,${kf[kf.length - 1].t.toFixed(3)})*${kf[kf.length - 1].z.toFixed(4)}`
  );
  return parts.join("+");
}

function buildCropDimensionExpr(kf: CropKF[], baseDim: number): string {
  if (kf.length === 0) {
    return String(baseDim);
  }

  const dimensions = kf.map((k) => {
    return Math.round(baseDim / k.z);
  });
  const minDim = Math.min(...dimensions);
  const maxDim = Math.max(...dimensions);
  const isConstant = maxDim - minDim < 1;

  if (isConstant) {
    return String(dimensions[0]);
  }

  const parts: string[] = [];
  const firstDim = dimensions[0];
  parts.push(`lt(t,${kf[0].t.toFixed(3)})*${firstDim}`);
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    const ta = a.t;
    const tb = b.t;
    const va = baseDim / a.z;
    const vb = baseDim / b.z;
    const slope = (vb - va) / Math.max(0.001, tb - ta);
    parts.push(
      `between(t,${ta.toFixed(3)},${tb.toFixed(3)})*(${Math.round(
        va
      )}+(${slope.toFixed(6)})*(t-${ta.toFixed(3)}))`
    );
  }
  const lastDim = dimensions[dimensions.length - 1];
  parts.push(`gte(t,${kf[kf.length - 1].t.toFixed(3)})*${lastDim}`);
  return parts.join("+");
}

export function buildFFmpegFilter(
  baseW: number,
  baseH: number,
  kf: CropKF[]
): string {
  const targetW = Math.floor((baseH * 9) / 16);
  const evenTargetW = Math.floor(targetW / 2) * 2;
  const zMin = Math.max(evenTargetW / baseW, 1.0, 0.88);
  let hasInvalidCrop = false;

  for (let i = 0; i < Math.min(5, kf.length); i++) {
    const k = kf[i];
    const cropW = Math.round(evenTargetW / k.z);
    const cropH = Math.round(baseH / k.z);

    if (cropW > baseW || cropH > baseH) {
      console.error(
        `[Framing] ERROR: Crop dimensions exceed video at t=${k.t.toFixed(
          2
        )}s: crop=(${cropW}x${cropH}) > video=(${baseW}x${baseH}), z=${k.z.toFixed(
          3
        )} (z_min should be ${zMin.toFixed(3)})`
      );
      hasInvalidCrop = true;
    }

    if (k.x < 0 || k.y < 0 || k.x + cropW > baseW || k.y + cropH > baseH) {
      console.error(
        `[Framing] ERROR: Invalid crop position at t=${k.t.toFixed(2)}s: pos=(${
          k.x
        },${k.y}) size=(${cropW}x${cropH}) video=(${baseW}x${baseH})`
      );
      hasInvalidCrop = true;
    }
  }

  if (hasInvalidCrop) {
    throw new Error(
      `[Framing] Invalid crop parameters detected. This indicates a bug in the zoom calculation.`
    );
  }

  const xExpr = buildPiecewiseExpr(kf, "x");
  const yExpr = buildPiecewiseExpr(kf, "y");
  const cropWExpr = buildCropDimensionExpr(kf, evenTargetW);
  const cropHExpr = buildCropDimensionExpr(kf, baseH);

  const isConstantX = !xExpr.includes("between");
  const isConstantY = !yExpr.includes("between");
  const isConstantW = !cropWExpr.includes("between");
  const isConstantH = !cropHExpr.includes("between");
  const constantCount = [
    isConstantX,
    isConstantY,
    isConstantW,
    isConstantH,
  ].filter(Boolean).length;

  if (constantCount > 0) {
    console.log(
      `[Framing] Static video optimization: ${constantCount}/4 expressions simplified to constants (saves ~${Math.round(
        kf.length * constantCount * 60
      )}B per constant)`
    );
  }

  const crop = `crop='${cropWExpr}':'${cropHExpr}':'${xExpr}':'${yExpr}'`;
  const scale = `scale=${evenTargetW}:${baseH}:eval=frame`;
  const fmt = `format=yuv420p`;

  const fullFilter = [crop, scale, fmt].join(",");
  const filterLength = fullFilter.length;

  console.log(
    `[Framing] Filter generated with ${
      kf.length
    } keyframes, zoom range: ${Math.min(...kf.map((k) => k.z)).toFixed(
      2
    )}-${Math.max(...kf.map((k) => k.z)).toFixed(2)}, expression length: ${(
      filterLength / 1024
    ).toFixed(1)}KB`
  );

  if (filterLength > 65536) {
    throw new Error(
      `[Framing] Filter expression is ${(filterLength / 1024).toFixed(
        1
      )}KB, exceeding FFmpeg limits (64KB). This indicates keyframe compression failed. Try reducing video duration or keyframe density.`
    );
  }

  if (filterLength > 32768) {
    console.warn(
      `[Framing] WARNING: Filter expression is ${(filterLength / 1024).toFixed(
        1
      )}KB, approaching FFmpeg limits. This may cause issues with some FFmpeg versions.`
    );
  }

  return fullFilter;
}

async function detectPersonsTimeline(
  videoPath: string,
  segStart: number,
  segEnd: number,
  baseW: number,
  baseH: number
): Promise<PersonSnapshot[]> {
  const duration = Math.max(0, segEnd - segStart);
  if (duration === 0) {
    return [];
  }
  const fps = DEFAULT_SAMPLE_FPS;
  const frameInterval = 1 / fps;
  const expectedFrames = Math.ceil(duration * fps);
  const tempDir = path.join(process.cwd(), "tmp", `pframes_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const FACE_CONF = Math.max(
    0,
    Math.min(1, Number(process.env.FACE_CONF || 0.5))
  );
  const POSE_CONF = Math.max(
    0,
    Math.min(1, Number(process.env.POSE_CONF || 0.3))
  );
  console.log(
    `[Person Detection] Config: PERSON_DETECT_WIDTH=${PERSON_DETECT_WIDTH}, FACE_CONF=${FACE_CONF}, POSE_CONF=${POSE_CONF}, MIN_DET_AREA=${MIN_DET_AREA}`
  );
  console.log(
    `[Person Detection] Extracting ${expectedFrames} frames at ${fps}fps from ${duration.toFixed(
      1
    )}s segment`
  );
  try {
    await extractFrames(videoPath, segStart, duration, fps, tempDir);
    const frameFiles = fs
      .readdirSync(tempDir)
      .filter((f) => {
        return f.endsWith(".jpg");
      })
      .sort();
    console.log(
      `[Person Detection] Extracted ${frameFiles.length} frames to ${tempDir}`
    );
    const out: PersonSnapshot[] = [];
    let frameIdx = 0;
    let tracks: Track[] = [];
    let nextTrackId = 1;
    for (let i = 0; i < frameFiles.length && i < expectedFrames; i++) {
      const framePath = path.join(tempDir, frameFiles[i]);
      const buffer = fs.readFileSync(framePath);
      const tensor = tf.node.decodeImage(buffer, 3) as tf.Tensor3D;
      try {
        const t = segStart + i * frameInterval;
        let dets: PersonDet[] = [];
        const doDetect = frameIdx % DETECT_EVERY === 0 || tracks.length === 0;
        if (doDetect) {
          dets = await detectPersons(tensor, baseW, baseH);
          const rawCount = dets.length;
          const detectorType =
            dets.length > 0 ? dets[0].detectorType : undefined;
          dets = dets.filter((d) => {
            return d.w * d.h >= MIN_DET_AREA;
          });
          const filteredCount = dets.length;
          if (rawCount > 0) {
            const avgConf =
              dets.length > 0
                ? (
                    dets.reduce((sum, d) => sum + d.score, 0) / dets.length
                  ).toFixed(3)
                : "0.000";
            const detectorLabel =
              detectorType === "face"
                ? "Face Detection"
                : detectorType === "pose"
                ? "Pose Detection"
                : "Person Detection";
            const detectionTypeLabel =
              detectorType === "face"
                ? "faces"
                : detectorType === "pose"
                ? "bodies"
                : "detections";
            console.log(
              `[${detectorLabel}] Frame ${frameIdx}: Found ${filteredCount} ${detectionTypeLabel} (${rawCount} raw, filtered by MIN_DET_AREA=${MIN_DET_AREA}), avg confidence: ${avgConf}`
            );
          }
          tracks = associateAndUpdate(
            tracks,
            dets,
            t,
            baseW,
            baseH,
            nextTrackId
          );
          const maxId = tracks.reduce((m, tr) => {
            return Math.max(m, tr.id);
          }, nextTrackId);
          nextTrackId = Math.max(nextTrackId, maxId + 1);
        } else {
          tracks = predictOnly(tracks, t, frameInterval, baseW, baseH);
        }
        const alive = tracks.filter((tr) => {
          return tr.hits >= TRACK_MIN_HITS && tr.w * tr.h >= MIN_TRACK_AREA;
        });
        const detLike: PersonDet[] = alive.map((tr) => {
          return {
            x: tr.x,
            y: tr.y,
            w: tr.w,
            h: tr.h,
            score: tr.score,
            id: tr.id,
          };
        });
        out.push({ t, dets: detLike });
        frameIdx++;
      } finally {
        tensor.dispose();
      }
    }
    return out;
  } catch (e) {
    console.error(`[Person Detection] ERROR in detectPersonsTimeline:`, e);
    console.error(`[Person Detection] Stack:`, (e as Error).stack);
    return [];
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function extractFrames(
  videoPath: string,
  segStart: number,
  duration: number,
  fps: number,
  outputDir: string
): Promise<void> {
  const ffmpegPath = require("ffmpeg-static");
  const scaleFilter =
    PERSON_DETECT_WIDTH > 0
      ? `fps=${fps},scale=${PERSON_DETECT_WIDTH}:-1`
      : `fps=${fps}`;
  await execFileAsync(ffmpegPath, [
    "-ss",
    segStart.toFixed(3),
    "-i",
    videoPath,
    "-t",
    duration.toFixed(3),
    "-vf",
    scaleFilter,
    "-q:v",
    "2",
    path.join(outputDir, "frame_%04d.jpg"),
  ]);
}

function iou(a: PersonDet, b: PersonDet): number {
  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const xx1 = Math.max(ax1, bx1);
  const yy1 = Math.max(ay1, by1);
  const xx2 = Math.min(ax2, bx2);
  const yy2 = Math.min(ay2, by2);
  if (xx2 <= xx1 || yy2 <= yy1) {
    return 0;
  }
  const inter = (xx2 - xx1) * (yy2 - yy1);
  const ra = a.w * a.h;
  const rb = b.w * b.h;
  const uni = ra + rb - inter;
  if (uni <= 0) {
    return 0;
  }
  return inter / uni;
}

function associateAndUpdate(
  prev: Track[],
  dets: PersonDet[],
  t: number,
  baseW: number,
  baseH: number,
  nextId: number
): Track[] {
  const predicted = prev.map((tr) => {
    const dt = Math.max(0.001, t - tr.lastT);
    const nx = clamp(Math.round(tr.x + tr.vx * dt), 0, baseW - tr.w);
    const ny = clamp(Math.round(tr.y + tr.vy * dt), 0, baseH - tr.h);
    return { ...tr, x: nx, y: ny };
  });
  const matches: Array<{ ti: number; di: number; iou: number }> = [];
  const usedD = new Set<number>();
  const usedT = new Set<number>();
  for (let ti = 0; ti < predicted.length; ti++) {
    let bestIdx = -1;
    let bestIou = 0;
    for (let di = 0; di < dets.length; di++) {
      if (usedD.has(di)) {
        continue;
      }
      const iv = iouTrackDet(predicted[ti], dets[di]);
      if (iv > bestIou) {
        bestIou = iv;
        bestIdx = di;
      }
    }
    if (bestIdx >= 0 && bestIou >= TRACK_IOU_THRESH) {
      matches.push({ ti, di: bestIdx, iou: bestIou });
      usedD.add(bestIdx);
      usedT.add(ti);
    }
  }
  const updated: Track[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const tr = predicted[m.ti];
    const det = dets[m.di];
    const dt = Math.max(0.001, t - tr.lastT);
    const pcx = tr.x + tr.w / 2;
    const pcy = tr.y + tr.h / 2;
    const dcx = det.x + det.w / 2;
    const dcy = det.y + det.h / 2;
    const vx = (dcx - pcx) / dt;
    const vy = (dcy - pcy) / dt;
    updated.push({
      id: tr.id,
      x: det.x,
      y: det.y,
      w: det.w,
      h: det.h,
      score: det.score,
      vx,
      vy,
      lastT: t,
      age: tr.age + dt,
      hits: tr.hits + 1,
      miss: 0,
    });
  }
  for (let ti = 0; ti < predicted.length; ti++) {
    if (usedT.has(ti)) {
      continue;
    }
    const tr = predicted[ti];
    const dt = Math.max(0.001, t - tr.lastT);
    const newAge = tr.age + dt;
    const newMiss = tr.miss + dt;
    if (newMiss <= TRACK_MAX_AGE_S) {
      updated.push({ ...tr, lastT: t, age: newAge, miss: newMiss });
    }
  }
  for (let di = 0; di < dets.length; di++) {
    if (usedD.has(di)) {
      continue;
    }
    const det = dets[di];
    updated.push({
      id: nextId++,
      x: det.x,
      y: det.y,
      w: det.w,
      h: det.h,
      score: det.score,
      vx: 0,
      vy: 0,
      lastT: t,
      age: 0,
      hits: 1,
      miss: 0,
    });
  }
  return updated;
}

function predictOnly(
  prev: Track[],
  t: number,
  dtDefault: number,
  baseW: number,
  baseH: number
): Track[] {
  const out: Track[] = [];
  for (let i = 0; i < prev.length; i++) {
    const tr = prev[i];
    const dt = Math.max(0.001, t - tr.lastT || dtDefault);
    const nx = clamp(Math.round(tr.x + tr.vx * dt), 0, baseW - tr.w);
    const ny = clamp(Math.round(tr.y + tr.vy * dt), 0, baseH - tr.h);
    const miss = tr.miss + dt;
    if (miss <= TRACK_MAX_AGE_S) {
      out.push({ ...tr, x: nx, y: ny, lastT: t, age: tr.age + dt, miss });
    }
  }
  return out;
}

function iouTrackDet(tr: Track, d: PersonDet): number {
  const ax1 = tr.x;
  const ay1 = tr.y;
  const ax2 = tr.x + tr.w;
  const ay2 = tr.y + tr.h;
  const bx1 = d.x;
  const by1 = d.y;
  const bx2 = d.x + d.w;
  const by2 = d.y + d.h;
  const xx1 = Math.max(ax1, bx1);
  const yy1 = Math.max(ay1, by1);
  const xx2 = Math.min(ax2, bx2);
  const yy2 = Math.min(ay2, by2);
  if (xx2 <= xx1 || yy2 <= yy1) {
    return 0;
  }
  const inter = (xx2 - xx1) * (yy2 - yy1);
  const ra = tr.w * tr.h;
  const rb = d.w * d.h;
  const uni = ra + rb - inter;
  if (uni <= 0) {
    return 0;
  }
  return inter / uni;
}

function buildTracks(
  snaps: PersonSnapshot[],
  baseW: number,
  baseH: number
): PersonSnapshot[] {
  const out: PersonSnapshot[] = [];
  let tracks: Track[] = [];
  let nextId = 1;
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    tracks = associateAndUpdate(tracks, s.dets, s.t, baseW, baseH, nextId);
    const maxId = tracks.reduce((m, tr) => {
      return Math.max(m, tr.id);
    }, nextId);
    nextId = Math.max(nextId, maxId + 1);
    const alive = tracks.filter((tr) => {
      return (
        tr.hits >= TRACK_MIN_HITS &&
        tr.miss <= TRACK_MAX_AGE_S &&
        tr.w * tr.h >= MIN_TRACK_AREA
      );
    });
    const detLike: PersonDet[] = alive.map((tr) => {
      return { x: tr.x, y: tr.y, w: tr.w, h: tr.h, score: tr.score, id: tr.id };
    });
    out.push({ t: s.t, dets: detLike });
  }
  return out;
}

function computeGlobalCropKeyframesFromTracksWithSpeechAndZoom(
  timeline: PersonSnapshot[],
  turns: SpeakerTurn[],
  baseW: number,
  baseH: number,
  constraints: Constraints
): CropKF[] {
  const targetW = Math.floor((baseH * 9) / 16);

  const map: Record<string, number> = {};
  const anchors: PersonDet[] = [];
  const bounds: Array<ReturnType<typeof boundsToGroup>> = [];
  const times: number[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const snap = timeline[i];
    if (snap.dets.length === 0) {
      continue;
    }
    const spk = activeSpeakerAt(snap.t, turns);
    let anchor: PersonDet | null = null;
    if (spk) {
      const mapped = map[spk];
      if (mapped !== undefined) {
        const found = snap.dets.find((d) => {
          return d.id === mapped;
        });
        if (found) {
          anchor = found;
        }
      }
      if (!anchor) {
        const pick = chooseAnchor(snap.dets, baseW, baseH);
        if (pick) {
          anchor = pick;
          if (pick.id !== undefined) {
            map[spk] = pick.id;
          }
        }
      }
    }
    if (!anchor) {
      anchor = chooseAnchor(snap.dets, baseW, baseH);
    }
    const b = computeBounds(snap.dets);
    anchors.push(anchor);
    bounds.push(boundsToGroup(b));
    times.push(snap.t);
  }

  if (anchors.length === 0) {
    return [];
  }

  const smoothingState: SmoothingState = {
    smoothedX: null,
    smoothedY: null,
  };
  const smoothedAnchors: Array<{ smoothedX: number; smoothedY: number }> = [];

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const rawX = anchor.x + anchor.w / 2;
    const rawY = anchor.y + anchor.h / 2;
    const smoothed = applyTemporalSmoothing(rawX, rawY, smoothingState);
    smoothedAnchors.push(smoothed);
  }

  const feasT: number[] = [];
  const xL: number[] = [];
  const xU: number[] = [];
  const yL: number[] = [];
  const yU: number[] = [];
  const xDes: number[] = [];
  const yDes: number[] = [];
  const wts: number[] = [];
  const groups: Array<{
    w: number;
    h: number;
    insetX: number;
    insetY: number;
  }> = [];

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const smoothed = smoothedAnchors[i];
    const f = buildFeasible(
      bounds[i],
      anchor,
      targetW,
      baseH,
      baseW,
      baseH,
      constraints,
      smoothed
    );
    feasT.push(times[i]);
    xL.push(f.xL);
    xU.push(f.xU);
    yL.push(f.yL);
    yU.push(f.yU);
    xDes.push(f.xDes);
    yDes.push(f.yDes);
    wts.push(anchor.score);
    groups.push({
      w: f.groupW,
      h: f.groupH,
      insetX: f.insetX,
      insetY: f.insetY,
    });
  }
  if (feasT.length === 0) {
    return [];
  }
  const xs = globalOptimize1D(
    feasT,
    xDes,
    xL,
    xU,
    wts,
    GLOB_LAMBDA_V,
    GLOB_LAMBDA_A,
    GLOB_ITERS,
    GLOB_LR
  );
  const ys = globalOptimize1D(
    feasT,
    yDes,
    yL,
    yU,
    wts,
    GLOB_LAMBDA_V,
    GLOB_LAMBDA_A,
    GLOB_ITERS,
    GLOB_LR
  );
  const zMinWidth = targetW / baseW;
  const zMinHeight = 1.0;
  const zMin = Math.max(zMinWidth, zMinHeight, Z_MIN);
  console.log(
    `[Framing] Dimension-aware z_min: ${zMin.toFixed(
      3
    )} (width: ${zMinWidth.toFixed(3)}, height: ${zMinHeight.toFixed(
      3
    )}, user: ${Z_MIN.toFixed(3)})`
  );
  const zs = solveZoomSeries(xs, ys, groups, targetW, baseH, zMin);
  const out: CropKF[] = [];
  for (let i = 0; i < feasT.length; i++) {
    const z = zs[i];
    const cropW = Math.round(targetW / z);
    const cropH = Math.round(baseH / z);

    const maxX = baseW - cropW;
    const maxY = baseH - cropH;

    const x = Math.max(0, Math.min(Math.round(xs[i]), maxX));
    const y = Math.max(0, Math.min(Math.round(ys[i]), maxY));

    if (i < 3) {
      console.log(
        `[Framing] KF ${i} at t=${feasT[i].toFixed(
          2
        )}s: pos=(${x},${y}) crop=(${cropW}x${cropH}) video=(${baseW}x${baseH}) z=${z.toFixed(
          3
        )}`
      );
    }

    out.push({ t: feasT[i], x, y, w: targetW, h: baseH, z, xs: 0, ys: 0 });
  }
  return out;
}

function compressCropMap(kf: CropKF[], maxKeyframes: number = 120): CropKF[] {
  if (kf.length <= 2) {
    return kf;
  }

  if (kf.length <= maxKeyframes) {
    const filtered: CropKF[] = [kf[0]];

    for (let i = 1; i < kf.length - 1; i++) {
      const prev = filtered[filtered.length - 1];
      const curr = kf[i];

      const timeDelta = curr.t - prev.t;
      if (timeDelta < 0.15) {
        continue;
      }

      const positionDelta = Math.sqrt(
        Math.pow(curr.x - prev.x, 2) + Math.pow(curr.y - prev.y, 2)
      );
      const zoomDelta = Math.abs(curr.z - prev.z);

      if (positionDelta < 1 && zoomDelta < 0.005) {
        continue;
      }

      filtered.push(curr);
    }

    filtered.push(kf[kf.length - 1]);
    return filtered;
  }

  const step = kf.length / (maxKeyframes - 1);
  const decimated: CropKF[] = [kf[0]];

  for (let i = 1; i < maxKeyframes - 1; i++) {
    const idx = Math.round(i * step);
    decimated.push(kf[idx]);
  }

  decimated.push(kf[kf.length - 1]);

  return decimated;
}

function boundsToGroup(b: {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}): {
  groupW: number;
  groupH: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  return {
    groupW: b.maxX - b.minX,
    groupH: b.maxY - b.minY,
    minX: b.minX,
    maxX: b.maxX,
    minY: b.minY,
    maxY: b.maxY,
  };
}

function applyTemporalSmoothing(
  rawX: number,
  rawY: number,
  smoothingState: SmoothingState
): { smoothedX: number; smoothedY: number } {
  if (smoothingState.smoothedX === null || smoothingState.smoothedY === null) {
    smoothingState.smoothedX = rawX;
    smoothingState.smoothedY = rawY;
    return { smoothedX: rawX, smoothedY: rawY };
  }

  const deltaX = rawX - smoothingState.smoothedX;
  const deltaY = rawY - smoothingState.smoothedY;

  let targetX = rawX;
  let targetY = rawY;

  if (Math.abs(deltaX) <= DEADZONE_X) {
    targetX = smoothingState.smoothedX;
  }

  if (Math.abs(deltaY) <= DEADZONE_Y) {
    targetY = smoothingState.smoothedY;
  }

  const newX =
    smoothingState.smoothedX +
    SMOOTH_ALPHA * (targetX - smoothingState.smoothedX);
  const newY =
    smoothingState.smoothedY +
    SMOOTH_ALPHA * (targetY - smoothingState.smoothedY);

  smoothingState.smoothedX = newX;
  smoothingState.smoothedY = newY;

  return { smoothedX: newX, smoothedY: newY };
}

function buildFeasible(
  group: {
    groupW: number;
    groupH: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  },
  anchor: PersonDet,
  targetW: number,
  targetH: number,
  baseW: number,
  baseH: number,
  constraints: Constraints,
  smoothedPosition: { smoothedX: number; smoothedY: number }
): {
  xL: number;
  xU: number;
  yL: number;
  yU: number;
  xDes: number;
  yDes: number;
  groupW: number;
  groupH: number;
  insetX: number;
  insetY: number;
} {
  const marginX = Math.max(0, constraints.margin) * targetW;
  const minMarginY = targetH * 0.1;
  const adaptiveMarginY = Math.max(minMarginY, group.groupH * 0.6);
  const topPad = Math.max(minMarginY, adaptiveMarginY * 0.6);
  const bottomPad = adaptiveMarginY;
  const paddedMinX = clamp(group.minX - marginX, 0, baseW);
  const paddedMaxX = clamp(group.maxX + marginX, 0, baseW);
  const paddedMinY = clamp(group.minY - topPad, 0, baseH);
  const paddedMaxY = clamp(group.maxY + bottomPad, 0, baseH);
  const frameCenterX = baseW / 2;
  const blend = Math.max(0, Math.min(1, constraints.centerBiasX));
  const desiredCenterX =
    smoothedPosition.smoothedX * blend + frameCenterX * (1 - blend);
  const torsoBias = Math.min(targetH * 0.18, group.groupH * 0.6);
  const desiredCenterY =
    (paddedMinY + paddedMaxY) / 2 +
    torsoBias -
    targetH * constraints.centerBiasY;
  const insetX = Math.max(8, Math.floor(targetW * 0.06));
  const insetY = Math.max(8, Math.floor(targetH * 0.08));
  let xL = clamp(
    paddedMaxX + insetX - targetW,
    0,
    Math.max(0, baseW - targetW)
  );
  let xU = clamp(paddedMinX - insetX, 0, Math.max(0, baseW - targetW));
  if (xL > xU) {
    const m = clamp(
      (paddedMinX + paddedMaxX) / 2 - targetW / 2,
      0,
      Math.max(0, baseW - targetW)
    );
    xL = m;
    xU = m;
  }
  const safeTop = -Math.round(targetH * constraints.safeTop);
  const safeBottom = Math.round(targetH * constraints.safeBottom);
  const minY = safeTop;
  const maxY = baseH - targetH + safeBottom;
  let yL = clamp(paddedMaxY + insetY - targetH, minY, maxY);
  let yU = clamp(paddedMinY - insetY, minY, maxY);
  if (yL > yU) {
    const m = clamp((paddedMinY + paddedMaxY) / 2 - targetH / 2, minY, maxY);
    yL = m;
    yU = m;
  }
  const xDes = clamp(desiredCenterX - targetW / 2, xL, xU);
  const yDes = clamp(desiredCenterY - targetH / 2, yL, yU);
  return {
    xL,
    xU,
    yL,
    yU,
    xDes,
    yDes,
    groupW: paddedMaxX - paddedMinX,
    groupH: paddedMaxY - paddedMinY,
    insetX,
    insetY,
  };
}

function solveZoomSeries(
  xs: number[],
  ys: number[],
  groups: Array<{ w: number; h: number; insetX: number; insetY: number }>,
  targetW: number,
  targetH: number,
  zMin: number
): number[] {
  const z: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const gw = groups[i].w;
    const gh = groups[i].h;
    const needX = (gw + 2 * groups[i].insetX) / targetW;
    const needY = (gh + 2 * groups[i].insetY) / targetH;
    let zr = 1;
    if (needX > 1 || needY > 1) {
      const need = Math.max(needX, needY);
      zr = Math.max(zMin, 1 / need);
    }
    if (i === 0) {
      z.push(zr);
    } else {
      const p = z[z.length - 1];
      const blended = p + Z_DECAY * (zr - p);
      z.push(Math.max(zMin, blended));
    }
  }
  return z;
}

function computeBounds(dets: PersonDet[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i];
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.w);
    maxY = Math.max(maxY, d.y + d.h);
  }
  return { minX, maxX, minY, maxY };
}

function chooseAnchor(
  dets: PersonDet[],
  baseW: number,
  baseH: number
): PersonDet {
  let best = dets[0];
  let bestScore = anchorScore(dets[0], baseW, baseH);
  for (let i = 1; i < dets.length; i++) {
    const s = anchorScore(dets[i], baseW, baseH);
    if (s > bestScore) {
      best = dets[i];
      bestScore = s;
    }
  }
  return best;
}

function anchorScore(d: PersonDet, baseW: number, baseH: number): number {
  const area = d.w * d.h;
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  const dx = Math.abs(cx - baseW / 2) / (baseW / 2);
  const dy = Math.abs(cy - baseH / 2) / (baseH / 2);
  const centr = 1 - Math.min(1, Math.hypot(dx, dy));
  return area * d.score * (0.5 + 0.5 * centr);
}

function buildSpeakerTurns(
  words: TranscriptWord[],
  segStart: number,
  segEnd: number
): SpeakerTurn[] {
  const filtered = words
    .filter((w) => {
      return w.speaker && w.end >= segStart && w.t <= segEnd;
    })
    .sort((a, b) => {
      return a.t - b.t;
    });
  if (filtered.length === 0) {
    return [];
  }
  const turns: SpeakerTurn[] = [];
  let cur: SpeakerTurn | null = null;
  for (let i = 0; i < filtered.length; i++) {
    const w = filtered[i];
    if (!cur) {
      cur = {
        start: Math.max(segStart, w.t),
        end: Math.min(segEnd, w.end),
        label: w.speaker!,
      };
      continue;
    }
    if (w.speaker === cur.label && w.t - cur.end <= 0.6) {
      cur.end = Math.min(segEnd, Math.max(cur.end, w.end));
    } else {
      turns.push(cur);
      cur = {
        start: Math.max(segStart, w.t),
        end: Math.min(segEnd, w.end),
        label: w.speaker!,
      };
    }
  }
  if (cur) {
    turns.push(cur);
  }
  return turns;
}

function activeSpeakerAt(t: number, turns: SpeakerTurn[]): string | null {
  let best: string | null = null;
  let bestOverlap = 0;
  const a = t - 0.6;
  const b = t + 0.2;
  for (let i = 0; i < turns.length; i++) {
    const u = Math.max(a, turns[i].start);
    const v = Math.min(b, turns[i].end);
    const ov = Math.max(0, v - u);
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = turns[i].label;
    }
  }
  return best;
}

function smoothKeyframes(kf: CropKF[]): CropKF[] {
  if (kf.length < 2) {
    return kf;
  }
  const out: CropKF[] = [];
  let sx = kf[0].x;
  let sy = kf[0].y;
  let sz = kf[0].z;
  out.push({
    t: kf[0].t,
    x: Math.round(sx),
    y: Math.round(sy),
    w: kf[0].w,
    h: kf[0].h,
    z: sz,
    xs: 0,
    ys: 0,
  });
  for (let i = 1; i < kf.length; i++) {
    sx = sx + SMOOTH_ALPHA * (kf[i].x - sx);
    sy = sy + SMOOTH_ALPHA * (kf[i].y - sy);
    sz = sz + SMOOTH_ALPHA * (kf[i].z - sz);
    out.push({
      t: kf[i].t,
      x: Math.round(sx),
      y: Math.round(sy),
      w: kf[i].w,
      h: kf[i].h,
      z: sz,
      xs: 0,
      ys: 0,
    });
  }
  return out;
}

function applyDeadzone(kf: CropKF[], dzx: number, dzy: number): CropKF[] {
  if (kf.length < 2) {
    return kf;
  }
  const out: CropKF[] = [kf[0]];
  for (let i = 1; i < kf.length; i++) {
    const prev = out[out.length - 1];
    const cur = kf[i];
    let nx = cur.x;
    let ny = cur.y;
    let nz = cur.z;
    if (Math.abs(cur.x - prev.x) < dzx) {
      nx = prev.x;
    }
    if (Math.abs(cur.y - prev.y) < dzy) {
      ny = prev.y;
    }
    if (Math.abs(cur.z - prev.z) < 0.01) {
      nz = prev.z;
    }
    out.push({
      t: cur.t,
      x: nx,
      y: ny,
      w: cur.w,
      h: cur.h,
      z: nz,
      xs: 0,
      ys: 0,
    });
  }
  return out;
}

function applyPanLimits(kf: CropKF[], maxPanPerSecond: number): CropKF[] {
  if (kf.length < 2) {
    return kf;
  }
  const limited: CropKF[] = [kf[0]];
  for (let i = 1; i < kf.length; i++) {
    const prev = limited[limited.length - 1];
    const cur = kf[i];
    const dt = Math.max(0.001, cur.t - prev.t);
    const maxDelta = Math.max(0, maxPanPerSecond) * dt;
    const nextX = stepToward(prev.x, cur.x, maxDelta);
    const nextY = stepToward(prev.y, cur.y, maxDelta);
    limited.push({
      t: cur.t,
      x: nextX,
      y: nextY,
      w: cur.w,
      h: cur.h,
      z: cur.z,
      xs: 0,
      ys: 0,
    });
  }
  return limited;
}

function applyAccelLimits(kf: CropKF[], maxAccelPerSecond: number): CropKF[] {
  if (kf.length < 3) {
    return kf;
  }
  const out: CropKF[] = [kf[0]];
  let vx = 0;
  let vy = 0;
  for (let i = 1; i < kf.length; i++) {
    const prev = out[out.length - 1];
    const cur = kf[i];
    const dt = Math.max(0.001, cur.t - prev.t);
    const tx = (cur.x - prev.x) / dt;
    const ty = (cur.y - prev.y) / dt;
    const ax = stepToward(vx, tx, maxAccelPerSecond * dt) - vx;
    const ay = stepToward(vy, ty, maxAccelPerSecond * dt) - vy;
    vx = vx + ax;
    vy = vy + ay;
    const nx = Math.round(prev.x + vx * dt);
    const ny = Math.round(prev.y + vy * dt);
    out.push({
      t: cur.t,
      x: nx,
      y: ny,
      w: cur.w,
      h: cur.h,
      z: cur.z,
      xs: 0,
      ys: 0,
    });
  }
  return out;
}

function easeSegmentEdges(
  kf: CropKF[],
  segStart: number,
  segEnd: number,
  easeSeconds: number
): CropKF[] {
  if (kf.length === 0 || easeSeconds <= 0) {
    return kf;
  }
  const eased: CropKF[] = [];
  for (let i = 0; i < kf.length; i++) {
    const frame = kf[i];
    const fromStart = Math.min(
      1,
      Math.max(0, (frame.t - segStart) / easeSeconds)
    );
    const fromEnd = Math.min(1, Math.max(0, (segEnd - frame.t) / easeSeconds));
    const influence = Math.min(fromStart, fromEnd);
    if (eased.length === 0) {
      eased.push(frame);
      continue;
    }
    const prev = eased[eased.length - 1];
    const x = Math.round(prev.x + (frame.x - prev.x) * influence);
    const y = Math.round(prev.y + (frame.y - prev.y) * influence);
    const z = prev.z + (frame.z - prev.z) * influence;
    eased.push({ t: frame.t, x, y, w: frame.w, h: frame.h, z, xs: 0, ys: 0 });
  }
  return eased;
}

function applyScaledCoords(
  kf: CropKF[],
  baseW: number,
  baseH: number
): CropKF[] {
  if (kf.length === 0) {
    return kf;
  }
  const targetW = Math.min(Math.floor((baseH * 9) / 16), baseW);
  const out: CropKF[] = [];
  for (let i = 0; i < kf.length; i++) {
    const z = kf[i].z;
    const cropW = Math.round(targetW / z);
    const cropH = Math.round(baseH / z);
    const maxX = Math.max(0, baseW - cropW);
    const maxY = Math.max(0, baseH - cropH);
    const clampedX = clamp(kf[i].x, 0, maxX);
    const clampedY = clamp(kf[i].y, 0, maxY);
    out.push({
      t: kf[i].t,
      x: clampedX,
      y: clampedY,
      w: cropW,
      h: cropH,
      z,
      xs: 0,
      ys: 0,
    });
  }
  return out;
}

function dedupeByTime(kf: CropKF[], minDelta: number): CropKF[] {
  if (kf.length === 0) {
    return kf;
  }
  const out: CropKF[] = [kf[0]];
  for (let i = 1; i < kf.length; i++) {
    if (kf[i].t - out[out.length - 1].t >= minDelta) {
      out.push(kf[i]);
    }
  }
  return out;
}

function stepToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) {
    return target;
  }
  return target > current ? current + maxDelta : current - maxDelta;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function globalOptimize1D(
  t: number[],
  des: number[],
  L: number[],
  U: number[],
  w: number[],
  lambdaV: number,
  lambdaA: number,
  iters: number,
  lr: number
): number[] {
  const n = des.length;
  const x = des.slice();
  const ww = w.map((s) => {
    return Math.max(0.2, Math.min(1, s));
  });
  for (let it = 0; it < iters; it++) {
    const g = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      g[i] += 2 * ww[i] * (x[i] - des[i]);
    }
    for (let i = 1; i < n; i++) {
      const dv = x[i] - x[i - 1];
      g[i] += 2 * lambdaV * dv;
      g[i - 1] -= 2 * lambdaV * dv;
    }
    for (let i = 1; i < n - 1; i++) {
      const da = x[i + 1] - 2 * x[i] + x[i - 1];
      g[i + 1] += 2 * lambdaA * da;
      g[i] += -4 * lambdaA * da;
      g[i - 1] += 2 * lambdaA * da;
    }
    for (let i = 0; i < n; i++) {
      x[i] = x[i] - lr * g[i];
      if (x[i] < L[i]) {
        x[i] = L[i];
      }
      if (x[i] > U[i]) {
        x[i] = U[i];
      }
    }
  }
  return x;
}

export async function computeCropMap(
  input: ComputeInput,
  constraints: Constraints
): Promise<CropKF[] | null> {
  try {
    const dynamicKf = await computeCropMapPerson(input, constraints);
    if (dynamicKf && dynamicKf.length > 0) {
      console.log(
        `[Framing] computeCropMap: using dynamic person-based crop (${dynamicKf.length} keyframes)`
      );
      return dynamicKf;
    }
  } catch (err) {
    console.error(
      "[Framing] computeCropMapPerson failed, falling back to static crop:",
      err
    );
  }

  try {
    const staticKf = await computeCropMapPersonStatic(input, constraints, null);
    if (staticKf && staticKf.length > 0) {
      console.log(
        `[Framing] computeCropMap: using static person-based crop (${staticKf.length} keyframe(s))`
      );
      return staticKf;
    }
  } catch (err) {
    console.error(
      "[Framing] computeCropMapPersonStatic failed in fallback:",
      err
    );
  }

  console.warn("[Framing] computeCropMap: no crop could be computed");
  return null;
}

export const __testables = {
  detectPersonsTimeline,
  buildTracks,
  computeGlobalCropKeyframesFromTracksWithSpeechAndZoom,
  buildSpeakerTurns,
  activeSpeakerAt,
  buildFFmpegFilter,
};
