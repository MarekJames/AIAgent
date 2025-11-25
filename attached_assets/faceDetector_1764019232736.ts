import * as faceapi from "@vladmandic/face-api";
import * as tf from "@tensorflow/tfjs-node";
import { Canvas, Image, ImageData, loadImage } from "canvas";
import { promises as fs } from "fs";
import path from "path";

// @ts-ignore
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

let modelsLoaded = false;

export async function initializeFaceDetection(): Promise<void> {
  if (modelsLoaded) {
    return;
  }

  try {
    const modelsPath = path.join(process.cwd(), "models");

    await fs.mkdir(modelsPath, { recursive: true });

    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsPath);

    modelsLoaded = true;
    console.log("Face detection models loaded successfully");
  } catch (error) {
    console.error("Error loading face detection models:", error);
    throw new Error("Failed to initialize face detection models");
  }
}

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

export async function detectFacesInImage(
  imagePath: string,
  videoWidth?: number,
  videoHeight?: number,
): Promise<FaceDetection[]> {
  if (!modelsLoaded) {
    throw new Error("Face detection models not loaded");
  }

  try {
    const img = await loadImage(imagePath);

    const frameWidth = img.width;
    const frameHeight = img.height;

    // Se nos derem a resolução do vídeo, usamos para escalar as boxes.
    const targetWidth = videoWidth ?? frameWidth;
    const targetHeight = videoHeight ?? frameHeight;

    const scaleX = targetWidth / frameWidth;
    const scaleY = targetHeight / frameHeight;

    const detections = await faceapi.detectAllFaces(
      img as any,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: 512,
        scoreThreshold: 0.2,
      }),
    );

    const minWidth = targetWidth * 0.035; // 3.5% em vez de 4%
    const minHeight = targetHeight * 0.035;

    const result: FaceDetection[] = [];

    for (const detection of detections) {
      const box = detection.box;

      // Coordenadas na resolução ORIGINAL do frame (640 etc.)
      const rawX = box.x;
      const rawY = box.y;
      const rawW = box.width;
      const rawH = box.height;

      // Escalar para a resolução DO VÍDEO (1920x1080)
      const x = rawX * scaleX;
      const y = rawY * scaleY;
      const width = rawW * scaleX;
      const height = rawH * scaleY;

      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const area = width * height;

      // Filtros em coordenadas do VÍDEO
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
      `Failed to load or detect faces in frame ${fileName}: ${error.message}`,
    );
    return [];
  }
}

export async function drawDebugFrame(
  imagePath: string,
  outputPath: string,
  faces: FaceDetection[],
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
): Promise<boolean> {
  try {
    const img = await loadImage(imagePath);

    const canvas = faceapi.createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(img as any, 0, 0);

    faces.forEach((face) => {
      ctx.strokeStyle = "#00ff00";
      ctx.lineWidth = 3;
      ctx.strokeRect(face.x, face.y, face.width, face.height);
    });

    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 4;
    ctx.strokeRect(cropX, cropY, cropWidth, cropHeight);

    ctx.fillStyle = "#ff0000";
    ctx.font = "24px Arial";
    ctx.fillText("Crop 9:16", cropX + 10, cropY + 30);

    const outBuffer = canvas.toBuffer("image/png");
    await fs.writeFile(outputPath, outBuffer);
    return true;
  } catch (error: any) {
    const fileName = path.basename(imagePath);
    console.warn(
      `Failed to generate debug frame from ${fileName}: ${error.message} (non-critical, continuing...)`,
    );
    return false;
  }
}
