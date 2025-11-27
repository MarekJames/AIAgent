CREATE TABLE "TikTokConnection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "openId" TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "scopes" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TikTokConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TikTokConnection_openId_key" ON "TikTokConnection"("openId");
ALTER TABLE "TikTokConnection" ADD CONSTRAINT "TikTokConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Clip" ADD COLUMN "tiktokPublishId" TEXT;
ALTER TABLE "Clip" ADD COLUMN "tiktokStatus" TEXT;
