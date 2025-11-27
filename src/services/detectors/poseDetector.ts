import * as poseDetection from "@tensorflow-models/pose-detection";
import * as tf from "@tensorflow/tfjs-node";

export type Detection = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
};

let poseDetector: poseDetection.PoseDetector | null = null;

const POSE_CONF = Math.max(
  0,
  Math.min(1, Number(process.env.POSE_CONF || 0.3))
);
const POSE_MIN_SIZE = Math.max(20, Number(process.env.POSE_MIN_SIZE || 100));

async function loadPoseModel(): Promise<void> {
  if (poseDetector) {
    return;
  }
  const model = poseDetection.SupportedModels.MoveNet;
  poseDetector = await poseDetection.createDetector(model, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
  });
  console.log(
    `[Pose Detection] Successfully loaded MoveNet SINGLEPOSE_LIGHTNING model`
  );
}

export async function detectPoses(
  img: tf.Tensor3D,
  baseW: number,
  baseH: number
): Promise<Detection[]> {
  await loadPoseModel();

  const srcH = img.shape[0];
  const srcW = img.shape[1];

  const poses = await poseDetector!.estimatePoses(img);

  const out: Detection[] = [];
  for (const pose of poses) {
    if (!pose.keypoints || pose.keypoints.length === 0) {
      continue;
    }

    const validPoints = pose.keypoints.filter((kp) => {
      return kp.score && kp.score >= POSE_CONF;
    });

    if (validPoints.length < 3) {
      continue;
    }

    let minX = srcW;
    let minY = srcH;
    let maxX = 0;
    let maxY = 0;
    let scoreSum = 0;

    for (const kp of validPoints) {
      minX = Math.min(minX, kp.x);
      minY = Math.min(minY, kp.y);
      maxX = Math.max(maxX, kp.x);
      maxY = Math.max(maxY, kp.y);
      scoreSum += kp.score || 0;
    }

    const avgScore = scoreSum / validPoints.length;
    const w = maxX - minX;
    const h = maxY - minY;

    if (w < POSE_MIN_SIZE || h < POSE_MIN_SIZE) {
      continue;
    }

    const bx = Math.round(minX * (baseW / srcW));
    const by = Math.round(minY * (baseH / srcH));
    const bw = Math.round(w * (baseW / srcW));
    const bh = Math.round(h * (baseH / srcH));

    out.push({
      x: bx,
      y: by,
      w: bw,
      h: bh,
      score: avgScore,
    });
  }

  return out;
}
