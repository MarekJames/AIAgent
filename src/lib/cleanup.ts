import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export function cleanupTempFiles(): void {
  const tmp = tmpdir()
  
  const cookieDir = join(tmp, 'yt-cookies')
  if (existsSync(cookieDir))
  {
    try {
      for (const file of readdirSync(cookieDir))
      {
        const filePath = join(cookieDir, file)
        try {
          rmSync(filePath, { force: true })
        }
        catch (err) {
          console.error(`Failed to remove cookie file ${file}:`, err)
        }
      }
      console.log('Cleaned up temp cookie files')
    }
    catch (err) {
      console.error('Failed to cleanup cookie directory:', err)
    }
  }
  
  try {
    const files = readdirSync(tmp)
    let cleaned = 0
    for (const file of files)
    {
      if (file.match(/\.(webm|mp4|m4a|part)$/))
      {
        const filePath = join(tmp, file)
        try {
          rmSync(filePath, { force: true })
          cleaned++
        }
        catch (err) {
          console.error(`Failed to remove temp file ${file}:`, err)
        }
      }
    }
    if (cleaned > 0)
    {
      console.log(`Cleaned up ${cleaned} temp video files`)
    }
  }
  catch (err) {
    console.error('Failed to cleanup temp directory:', err)
  }
}
