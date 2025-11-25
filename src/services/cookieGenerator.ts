import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { prisma } from '@/src/lib/prisma'

const COOKIE_MAX_AGE_DAYS = 21

export async function saveCookies(userId: string, cookieContent: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      youtubeCookies: cookieContent,
      youtubeCookiesCreatedAt: new Date(),
      youtubeCookiesLastUsedAt: new Date(),
    },
  })
  console.log(`Cookies saved for user ${userId}`)
}

export async function getCookieFilePath(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      youtubeCookies: true,
      youtubeCookiesCreatedAt: true,
    },
  })

  if (!user || !user.youtubeCookies) {
    console.warn(`No YouTube cookies found for user ${userId}`)
    return null
  }

  const tempFile = join(tmpdir(), `yt_cookies_${userId}_${Date.now()}.txt`)
  await fs.writeFile(tempFile, user.youtubeCookies, { encoding: 'utf-8', mode: 0o600 })

  if (user.youtubeCookiesCreatedAt) {
    const ageInDays = (Date.now() - user.youtubeCookiesCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
    
    if (ageInDays > COOKIE_MAX_AGE_DAYS) {
      console.warn(`YouTube cookies for user ${userId} are ${Math.floor(ageInDays)} days old and may be expired`)
    }
    else {
      console.log(`Using YouTube cookies for user ${userId} (${Math.floor(ageInDays)} days old)`)
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: { youtubeCookiesLastUsedAt: new Date() },
  })

  return tempFile
}

export async function cleanupCookieFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  }
  catch {
  }
}

export async function getCookieAge(userId: string): Promise<number | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { youtubeCookiesCreatedAt: true },
  })

  if (!user || !user.youtubeCookiesCreatedAt) {
    return null
  }

  return (Date.now() - user.youtubeCookiesCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
}

export async function clearCookies(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      youtubeCookies: null,
      youtubeCookiesCreatedAt: null,
      youtubeCookiesLastUsedAt: null,
    },
  })
  console.log(`YouTube cookies cleared for user ${userId}`)

  const pattern = `yt_cookies_${userId}_`
  try {
    const files = await fs.readdir(tmpdir())
    for (const file of files)
    {
      if (file.startsWith(pattern))
      {
        try {
          await fs.unlink(join(tmpdir(), file))
        }
        catch {
        }
      }
    }
  }
  catch {
  }
}
