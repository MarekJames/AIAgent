import * as faceapi from "@vladmandic/face-api";
import * as tf from "@tensorflow/tfjs-node";
import * as path from "path";

export type Detection = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
};

let faceModelsLoaded = false;

const FACE_CONF = Math.max(
  0,
  Math.min(1, Number(process.env.FACE_CONF || 0.5))
);
const FACE_MIN_SIZE = Math.max(20, Number(process.env.FACE_MIN_SIZE || 80));

async function loadFaceModels(): Promise<void> {
  if (faceModelsLoaded) {
    return;
  }
  const modelsPath = path.join(process.cwd(), "models");
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
  faceModelsLoaded = true;
  console.log(
    `[Face Detection] Successfully loaded SSD MobileNet v1 model from ${modelsPath}`
  );
}

export async function detectFaces(
  img: tf.Tensor3D,
  baseW: number,
  baseH: number
): Promise<Detection[]> {
  await loadFaceModels();

  const srcH = img.shape[0];
  const srcW = img.shape[1];

  const detections = await faceapi.detectAllFaces(
    img as any,
    new faceapi.SsdMobilenetv1Options({ minConfidence: FACE_CONF })
  );

  const out: Detection[] = [];
  for (const det of detections) {
    const box = det.box;
    const x1 = Math.max(0, box.x);
    const y1 = Math.max(0, box.y);
    const x2 = Math.min(srcW, box.x + box.width);
    const y2 = Math.min(srcH, box.y + box.height);
    const w = x2 - x1;
    const h = y2 - y1;

    if (w < FACE_MIN_SIZE || h < FACE_MIN_SIZE) {
      continue;
    }

    const bx = Math.round(x1 * (baseW / srcW));
    const by = Math.round(y1 * (baseH / srcH));
    const bw = Math.round(w * (baseW / srcW));
    const bh = Math.round(h * (baseH / srcH));

    out.push({
      x: bx,
      y: by,
      w: bw,
      h: bh,
      score: det.score,
    });
  }

  return out;
}
