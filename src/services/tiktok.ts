import { promises as fsp } from "fs";
import { createReadStream } from "fs";

type EnsureTokenInput = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

type EnsureTokenOutput = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  rotated: boolean;
};

async function throwIfNotOk(res: Response, label: string) {
  if (res.ok) {
    return;
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  const detail = body ? JSON.stringify(body) : await res.text().catch(() => "");
  throw new Error(`${label} ${res.status} ${detail}`);
}

export async function ensureAccessToken(
  input: EnsureTokenInput
): Promise<EnsureTokenOutput> {
  const now = Date.now();
  const exp = input.expiresAt ? input.expiresAt.getTime() : 0;
  if (exp - now > 120000) {
    return {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      rotated: false,
    };
  }
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY as string,
      client_secret: process.env.TIKTOK_CLIENT_SECRET as string,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });
  await throwIfNotOk(res, "tiktok refresh failed");
  if (!res.ok) {
    throw new Error(`tiktok refresh failed ${res.status}`);
  }
  const j = await res.json();
  const at = j.access_token as string;
  const rt = (j.refresh_token as string) || input.refreshToken;
  const expiresIn = Number(j.expires_in || 3600);
  const until = new Date(Date.now() + expiresIn * 1000);
  return { accessToken: at, refreshToken: rt, expiresAt: until, rotated: true };
}

type InitUploadInput = {
  accessToken: string;
  filePath: string;
  chunkSizeBytes?: number;
};

type InitUploadOutput = {
  uploadUrl: string;
  publishId: string;
  fileSize: number;
  chunkSizeBytes: number;
  totalChunks: number;
};

export async function initUpload(input: {
  accessToken: string;
  filePath: string;
  chunkSizeBytes?: number;
}): Promise<{
  uploadUrl: string;
  publishId: string;
  fileSize: number;
  chunkSizeBytes: number;
  totalChunks: number;
}> {
  const stat = await fsp.stat(input.filePath);
  const fileSize = stat.size;

  const MB = 1_000_000;
  const FIVE_MB = 5 * MB;
  const SIXTY_FOUR_MB = 64 * MB;

  let chunkSizeBytes: number;
  let totalChunks: number;

  if (fileSize < FIVE_MB) {
    chunkSizeBytes = fileSize;
    totalChunks = 1;
  } else if (fileSize <= SIXTY_FOUR_MB) {
    chunkSizeBytes = fileSize;
    totalChunks = 1;
  } else {
    const preferred =
      input.chunkSizeBytes && input.chunkSizeBytes > 0
        ? input.chunkSizeBytes
        : 10 * MB;
    chunkSizeBytes = Math.max(
      FIVE_MB,
      Math.min(preferred, SIXTY_FOUR_MB, fileSize)
    );
    totalChunks = Math.floor(fileSize / chunkSizeBytes);
    if (totalChunks < 1) totalChunks = 1;
    if (totalChunks > 1000) {
      chunkSizeBytes = Math.ceil(fileSize / 1000);
      chunkSizeBytes = Math.max(
        FIVE_MB,
        Math.min(chunkSizeBytes, SIXTY_FOUR_MB, fileSize)
      );
      totalChunks = Math.max(1, Math.floor(fileSize / chunkSizeBytes));
    }
  }

  const res = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileSize,
          chunk_size: chunkSizeBytes,
          total_chunk_count: totalChunks,
        },
      }),
    }
  );

  await throwIfNotOk(res, "tiktok init failed");
  const j = await res.json();
  const uploadUrl = j.data?.upload_url as string;
  const publishId = j.data?.publish_id as string;
  if (!uploadUrl || !publishId)
    throw new Error("tiktok init missing upload_url or publish_id");

  return { uploadUrl, publishId, fileSize, chunkSizeBytes, totalChunks };
}

type UploadToUrlInput = {
  uploadUrl: string;
  filePath: string;
  fileSize: number;
  chunkSizeBytes: number;
};

export async function uploadToUrl(input: {
  uploadUrl: string;
  filePath: string;
  fileSize: number;
  chunkSizeBytes: number;
  totalChunks: number;
}) {
  const { uploadUrl, filePath, fileSize, chunkSizeBytes, totalChunks } = input;
  if (fileSize === 0) return;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSizeBytes;
    const endExclusive =
      i < totalChunks - 1 ? start + chunkSizeBytes : fileSize;
    const lastByte = endExclusive - 1;
    const length = endExclusive - start;

    const nodeStream = createReadStream(filePath, { start, end: lastByte });

    const res = await fetch(uploadUrl, {
      method: "PUT",
      ...({ duplex: "half" } as any),
      body: nodeStream as any,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(length),
        "Content-Range": `bytes ${start}-${lastByte}/${fileSize}`,
      },
    });

    await throwIfNotOk(res, "tiktok upload failed");
  }
}

type PublishVideoInput = {
  accessToken: string;
  publishId: string;
  caption: string;
  mode: "draft" | "publish";
};

type PublishVideoOutput = {
  ok: boolean;
};

export async function publishVideo(
  input: PublishVideoInput
): Promise<PublishVideoOutput> {
  if (input.mode !== "publish") {
    throw new Error('publishVideo requires mode "publish"');
  }
  const res = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/video/",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        publish_id: input.publishId,
        post_info: {
          title: input.caption,
          visibility: "public",
          disable_duet: true,
          disable_stitch: true,
          disable_comment: false,
        },
      }),
    }
  );
  await throwIfNotOk(res, "tiktok publish failed");
  if (!res.ok) {
    throw new Error(`tiktok publish failed ${res.status}`);
  }
  return { ok: true };
}
