import * as tf from "@tensorflow/tfjs-node"
import { detectFaces } from "./faceDetector"
import { detectPoses } from "./poseDetector"

export type PersonDet = {
  x: number
  y: number
  w: number
  h: number
  score: number
  detectorType?: 'face' | 'pose'
}

export async function detectPersons(
  img: tf.Tensor3D,
  baseW: number,
  baseH: number
): Promise<PersonDet[]> {
  const faces = await detectFaces(img, baseW, baseH)
  
  if (faces.length > 0) {
    return faces.map(f => ({ ...f, detectorType: 'face' as const }))
  }
  
  const poses = await detectPoses(img, baseW, baseH)
  return poses.map(p => ({ ...p, detectorType: 'pose' as const }))
}
