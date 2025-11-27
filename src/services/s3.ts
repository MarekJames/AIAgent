import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFileSync } from "fs";

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || "auto",
  credentials:
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const bucket = process.env.S3_BUCKET!;

export async function uploadFile(
  key: string,
  filePath: string,
  contentType: string
): Promise<string> {
  const fileContent = readFileSync(filePath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileContent,
      ContentType: contentType,
      ContentDisposition: "inline",
    })
  );

  if (process.env.S3_ENDPOINT) {
    return `${process.env.S3_ENDPOINT}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
}

export async function getSignedUrlForKey(
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: "inline",
    })
  );

  if (process.env.S3_ENDPOINT) {
    return `${process.env.S3_ENDPOINT}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
}

export function getS3Url(key: string): string {
  if (process.env.S3_ENDPOINT) {
    return `${process.env.S3_ENDPOINT}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
}
