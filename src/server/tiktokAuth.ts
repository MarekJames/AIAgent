import { prisma } from "@/src/lib/prisma";
import { encrypt, decrypt } from "@/src/lib/encryption";

export async function getTikTokAccessTokenByUserId(userId: string) {
  const row = await prisma.tikTokConnection.findFirst({ where: { userId } });
  if (!row) {
    return null;
  }
  if (Date.now() < row.expiresAt.getTime()) {
    return decrypt(row.accessToken);
  }
  const body = new URLSearchParams();
  body.set("client_key", process.env.TIKTOK_CLIENT_KEY || "");
  console.log("client_key", process.env.TIKTOK_CLIENT_KEY);
  body.set("client_secret", process.env.TIKTOK_CLIENT_SECRET || "");
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", decrypt(row.refreshToken));
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!data.access_token) {
    return null;
  }
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await prisma.tikTokConnection.update({
    where: { id: row.id },
    data: {
      accessToken: encrypt(data.access_token),
      refreshToken: encrypt(data.refresh_token || decrypt(row.refreshToken)),
      expiresAt,
    },
  });
  return data.access_token;
}
