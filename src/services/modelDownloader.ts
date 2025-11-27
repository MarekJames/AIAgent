import { promises as fs } from "fs";
import path from "path";
import https from "https";

const MODEL_FILES = [
  "tiny_face_detector_model-weights_manifest.json",
  "tiny_face_detector_model.bin",
];

const BASE_URL = "https://vladmandic.github.io/face-api/model/";

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(
            new Error(`Failed to download ${url}: ${response.statusCode}`)
          );
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", async () => {
          try {
            await fs.writeFile(dest, Buffer.concat(chunks));
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

export async function ensureModelsDownloaded(): Promise<void> {
  const modelsPath = path.join(process.cwd(), "models");

  await fs.mkdir(modelsPath, { recursive: true });

  const modelFiles: string[] = await fs.readdir(modelsPath).catch(() => []);
  const allExist = MODEL_FILES.every((file) => modelFiles.includes(file));

  if (allExist) {
    console.log("Face detection models already exist");
    return;
  }

  console.log("Downloading face detection models...");

  for (const file of MODEL_FILES) {
    const url = BASE_URL + file;
    const dest = path.join(modelsPath, file);

    try {
      console.log(`Downloading ${file}...`);
      await downloadFile(url, dest);
      console.log(`Downloaded ${file}`);
    } catch (error) {
      console.error(`Error downloading ${file}:`, error);
      throw error;
    }
  }

  console.log("All models downloaded successfully");
}
