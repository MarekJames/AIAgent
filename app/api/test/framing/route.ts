import { NextResponse } from "next/server"
import { promisify } from "util"
import * as fs from "fs"
import * as path from "path"
import { computeCropMapPersonStatic, computeGlobalStaticCrop, CropKF, buildFFmpegFilter } from "@/src/services/framingService"
import { renderSmartFramedClip } from "@/src/services/ffmpeg"
import { getIntroEndFromChapters } from "@/src/services/youtube"
import { getCookieFilePath, cleanupCookieFile } from "@/src/services/cookieGenerator"
import { getCurrentUserId } from "@/src/lib/session"

const execFile = promisify(require("child_process").execFile)

type ValidationResult = {
  passed: boolean
  message: string
  details?: any
}

function validateZoomConstraints(cropMap: CropKF[], baseW: number, baseH: number): ValidationResult[] {
  const results: ValidationResult[] = []
  
  const targetW = Math.round((baseH * 9) / 16)
  const zMinWidth = targetW / baseW
  const zMinHeight = 1.0
  const expectedZMin = Math.max(zMinWidth, zMinHeight, 0.88)

  results.push({
    passed: true,
    message: "Z_min calculation",
    details: {
      targetW,
      zMinWidth: zMinWidth.toFixed(3),
      zMinHeight: zMinHeight.toFixed(3),
      expectedZMin: expectedZMin.toFixed(3)
    }
  })

  const zoomValues = cropMap.map(kf => kf.z)
  const minZ = Math.min(...zoomValues)
  const maxZ = Math.max(...zoomValues)

  results.push({
    passed: minZ >= expectedZMin - 0.001,
    message: "Zoom values respect z_min constraint",
    details: {
      minZ: minZ.toFixed(3),
      maxZ: maxZ.toFixed(3),
      expectedZMin: expectedZMin.toFixed(3),
      allValid: minZ >= expectedZMin - 0.001
    }
  })

  let invalidCrops = 0
  for (const kf of cropMap.slice(0, 10)) {
    const cropW = Math.round(baseW / kf.z)
    const cropH = Math.round(baseH / kf.z)
    
    if (cropW > baseW || cropH > baseH)
    {
      invalidCrops++
    }
  }

  results.push({
    passed: invalidCrops === 0,
    message: "Crop dimensions within video bounds",
    details: {
      baseW,
      baseH,
      invalidCrops,
      sampledKeyframes: Math.min(10, cropMap.length)
    }
  })

  return results
}

async function downloadTestVideo(
  url: string,
  startTime: number,
  endTime: number,
  tempDir: string,
  userId: string
): Promise<{ path: string; width: number; height: number; duration: number }> {
  const outputPath = path.join(tempDir, "test.mp4")
  const duration = endTime - startTime

  console.log(`[Framing Test] Downloading ${duration}s from ${url} (${startTime}s to ${endTime}s)`)

  const cookieFile = await getCookieFilePath(userId)
  
  const args = [
    "-f",
    "best[height<=1080][ext=mp4]",
    "--download-sections",
    `*${startTime}-${endTime}`,
    "-o",
    outputPath,
    url
  ]

  if (cookieFile && fs.existsSync(cookieFile))
  {
    args.splice(0, 0, "--cookies", cookieFile)
    console.log(`[Framing Test] Using cookie file for authentication`)
  }
  else
  {
    console.warn(`[Framing Test] No cookie file available - download may fail for some videos`)
  }

  try {
    await execFile("yt-dlp", args, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 })
  } catch (error: any) {
    throw new Error(`Video download failed: ${error.message}`)
  } finally {
    if (cookieFile)
    {
      await cleanupCookieFile(cookieFile)
    }
  }

  if (!fs.existsSync(outputPath))
  {
    throw new Error("Download failed: output file not found")
  }

  const ffprobePath = require("ffprobe-static").path
  let probe: any
  
  try {
    const { stdout } = await execFile(ffprobePath, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration",
      "-of",
      "json",
      outputPath
    ])
    probe = JSON.parse(stdout)
  } catch (error: any) {
    throw new Error(`Failed to probe video: ${error.message}`)
  }

  if (!probe.streams || probe.streams.length === 0)
  {
    throw new Error("No video stream found in downloaded file")
  }

  const width = probe.streams[0].width
  const height = probe.streams[0].height
  const videoDuration = parseFloat(probe.streams[0].duration || "0")

  if (!width || !height)
  {
    throw new Error(`Invalid video dimensions: ${width}x${height}`)
  }

  if (!videoDuration || videoDuration <= 0)
  {
    throw new Error(`Invalid video duration: ${videoDuration}`)
  }

  console.log(`[Framing Test] Downloaded ${width}x${height} video (${videoDuration.toFixed(2)}s actual) to ${outputPath}`)
  return { path: outputPath, width, height, duration: videoDuration }
}

export async function POST(request: Request) {
  let userId: string

  try {
    userId = await getCurrentUserId()
  } catch (error) {
    if (error instanceof Error && error.message === "Authentication required")
    {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required. Please log in to use the framing test."
        },
        { status: 401 }
      )
    }
    throw error
  }
  
  if (!userId)
  {
    return NextResponse.json(
      {
        success: false,
        error: "User ID not found in session. Please log in again."
      },
      { status: 401 }
    )
  }
  
  const testId = Date.now()
  const tempDir = path.join(process.cwd(), "tmp", `framing_test_${testId}`)
  fs.mkdirSync(tempDir, { recursive: true })
  
  try {
    const { initializeCanvas } = await import("@/src/services/framingService")
    await initializeCanvas()
    
    const body = await request.json()
    const url = body.url || "https://www.youtube.com/watch?v=EngW7tLk6R8"
    const durationMinutes = typeof body.durationMinutes === "number" ? body.durationMinutes : 3

    const startTime = 0
    const endTime = durationMinutes * 60
    const requestedDuration = endTime - startTime
    
    if (requestedDuration <= 0 || requestedDuration > 300)
    {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid duration: ${requestedDuration}s (must be 1-300s)`,
          testId
        },
        { status: 400 }
      )
    }
    
    console.log(`[Framing Test] Starting test ${testId}`)
    console.log(`[Framing Test] URL: ${url}`)
    console.log(`[Framing Test] Time range: ${startTime}s to ${endTime}s (${requestedDuration}s)`)

    const { path: videoPath, width, height, duration: actualDuration } = await downloadTestVideo(
      url,
      startTime,
      endTime,
      tempDir,
      userId
    )
    
    const cookieFile = await getCookieFilePath(userId)
    const introEndSec = await getIntroEndFromChapters(url, cookieFile ?? undefined)
    const renderStartTime = introEndSec && introEndSec < actualDuration ? introEndSec : 0
    const renderDuration = actualDuration - renderStartTime
    
    if (introEndSec)
    {
      console.log(`[Framing Test] Intro chapter detected at ${introEndSec.toFixed(1)}s, will skip in final render`)
    }
    
    console.log(`[Framing Test] Computing GLOBAL crop for entire video...`)
    const globalCrop = await computeGlobalStaticCrop(
      videoPath,
      actualDuration,
      width,
      height,
      { skipUntilSec: introEndSec ?? 0 }
    )
    
    if (globalCrop)
    {
      console.log(`[Framing Test] ✓ Global crop computed successfully`)
    }
    else
    {
      console.log(`[Framing Test] ⚠️  Global crop failed, will use per-segment detection`)
    }
    
    console.log(`[Framing Test] Running person detection and framing (static mode)...`)
    const cropMap = await computeCropMapPersonStatic(
      {
        videoPath,
        baseW: width,
        baseH: height,
        segStart: renderStartTime,
        segEnd: actualDuration,
        transcript: []
      },
      {
        margin: 0.02,
        maxPan: 400,
        easeMs: 600,
        centerBiasX: 0.75,
        centerBiasY: 0.15,
        safeTop: 0.05,
        safeBottom: 0.1
      },
      globalCrop
    )

    if (!cropMap || cropMap.length === 0)
    {
      return NextResponse.json({
        success: false,
        error: "No people detected in video",
        testId
      })
    }

    console.log(`[Framing Test] Generated crop map with ${cropMap.length} keyframes`)
    
    const validations = validateZoomConstraints(cropMap, width, height)
    
    const outputPath = path.join(tempDir, "framed.mp4")
    console.log(
      `[Framing Test] Rendering framed video from ${renderStartTime.toFixed(1)}s to ${actualDuration.toFixed(1)}s...`
    )
    
    const filterExpr = buildFFmpegFilter(width, height, cropMap)
    
    await renderSmartFramedClip({
      inputPath: videoPath,
      outputPath,
      startTime: renderStartTime,
      duration: renderDuration,
      srtPath: "",
      filterExpr
    })

    if (!fs.existsSync(outputPath))
    {
      return NextResponse.json({
        success: false,
        error: "Render failed: output file not found",
        testId
      })
    }

    let outputW = 1080
    let outputH = 1920
    let outputValid = true

    try {
      const { stdout: outputProbe } = await execFile(require("ffprobe-static").path, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        outputPath
      ])
      
      const outputInfo = JSON.parse(outputProbe)
      
      if (outputInfo.streams && outputInfo.streams.length > 0)
      {
        outputW = outputInfo.streams[0].width || 1080
        outputH = outputInfo.streams[0].height || 1920
        outputValid = Math.abs(outputW / outputH - 9 / 16) < 0.01
      }
    } catch (error: any) {
      console.warn(`[Framing Test] Failed to probe output video: ${error.message}. Using defaults.`)
    }

    console.log(
      `[Framing Test] Test complete - ${
        validations.every(v => v.passed) && outputValid ? "PASSED" : "FAILED"
      }`
    )

    const resultsDir = path.join(process.cwd(), "tmp", "framing-results")
    fs.mkdirSync(resultsDir, { recursive: true })
    
    const storedOriginal = path.join(resultsDir, `original_${testId}.mp4`)
    const storedFramed = path.join(resultsDir, `framed_${testId}.mp4`)
    
    fs.copyFileSync(videoPath, storedOriginal)
    fs.copyFileSync(outputPath, storedFramed)

    return NextResponse.json({
      success: true,
      testId,
      results: {
        video: {
          width,
          height,
          duration: actualDuration
        },
        globalCrop: globalCrop
          ? {
              cropX: globalCrop.cropX,
              cropY: globalCrop.cropY,
              cropW: globalCrop.cropW,
              cropH: globalCrop.cropH,
              zMin: globalCrop.zMin
            }
          : null,
        detection: {
          keyframes: cropMap.length,
          requestedDuration,
          actualDuration
        },
        validations: validations.map(v => ({
          test: v.message,
          passed: v.passed,
          details: v.details
        })),
        output: {
          width: outputW,
          height: outputH,
          aspectRatio: (outputW / outputH).toFixed(3),
          expectedAspectRatio: (9 / 16).toFixed(3),
          valid: outputValid
        },
        videos: {
          original: `/api/test/framing?type=original&id=${testId}`,
          framed: `/api/test/framing?type=framed&id=${testId}`
        }
      }
    })
  } catch (error: any) {
    console.error("[Framing Test] Error:", error)
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Test failed",
        testId
      },
      { status: 500 }
    )
  } finally {
    if (fs.existsSync(tempDir))
    {
      fs.rmSync(tempDir, { recursive: true, force: true })
      console.log(`[Framing Test] Cleaned up temp directory: ${tempDir}`)
    }
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get("id")
  const type = url.searchParams.get("type")

  if (!id || !type)
  {
    return new NextResponse("Missing id or type", { status: 400 })
  }

  if (type !== "original" && type !== "framed")
  {
    return new NextResponse("Invalid type", { status: 400 })
  }

  const resultsDir = path.join(process.cwd(), "tmp", "framing-results")
  const filePath = path.join(resultsDir, `${type}_${id}.mp4`)

  if (!fs.existsSync(filePath))
  {
    return new NextResponse("Not found", { status: 404 })
  }

  const fileBuffer = await fs.promises.readFile(filePath)

  return new NextResponse(fileBuffer as any, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileBuffer.length)
    }
  })
}
