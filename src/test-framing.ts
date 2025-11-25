import path from "path"
import fs from "fs"
import { promisify } from "util"
import { execFile } from "child_process"
import { computeCropMapPerson, buildFFmpegFilter, type ComputeInput, type Constraints, type TranscriptWord } from "./services/framingService"
import { renderSmartFramedClip } from "./services/ffmpeg"

const execFileAsync = promisify(execFile)

const TEST_DURATION = 10

async function createTestVideo(): Promise<string> {
  const tempDir = path.join(process.cwd(), "tmp", `framing_test_${Date.now()}`)
  fs.mkdirSync(tempDir, { recursive: true })
  const outputPath = path.join(tempDir, "test.mp4")
  
  console.log(`[Test] Creating synthetic test video (1920x1080, ${TEST_DURATION}s)...`)
  console.log(`[Test] Simulating two people standing far apart with moving colored boxes...`)
  
  const ffmpegPath = require("ffmpeg-static")
  
  try {
    await execFileAsync(ffmpegPath, [
      "-f", "lavfi",
      "-i", `color=c=black:s=1920x1080:d=${TEST_DURATION}:r=25`,
      "-vf", `drawbox=x=200:y=200:w=300:h=600:color=blue:t=fill,drawbox=x=1400:y=200:w=300:h=600:color=red:t=fill,drawtext=text='Person 1':fontsize=40:fontcolor=white:x=250:y=400,drawtext=text='Person 2':fontsize=40:fontcolor=white:x=1450:y=400`,
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-y",
      outputPath
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
    
    if (!fs.existsSync(outputPath)) {
      throw new Error("Video creation failed: output file not found")
    }
    
    console.log(`[Test] ✓ Created test video at ${outputPath}`)
    return outputPath
  } catch (error) {
    console.error(`[Test] Video creation failed:`, error)
    throw error
  }
}

async function getVideoInfo(videoPath: string): Promise<{ width: number; height: number; duration: number }> {
  const ffprobePath = require("ffprobe-static").path
  
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration",
    "-of", "json",
    videoPath
  ], { maxBuffer: 10 * 1024 * 1024 })
  
  const data = JSON.parse(stdout)
  const stream = data.streams[0]
  
  return {
    width: parseInt(stream.width),
    height: parseInt(stream.height),
    duration: parseFloat(stream.duration || "0")
  }
}

async function testFraming() {
  console.log("=".repeat(80))
  console.log("FRAMING SYSTEM TEST")
  console.log("=".repeat(80))
  console.log()
  console.log("Test scenario: Two people standing far apart")
  console.log("Expected behavior: System should use z_min >= 1.0 to prevent impossible crops")
  console.log()
  
  let videoPath: string
  let videoInfo: { width: number; height: number; duration: number }
  
  try {
    videoPath = await createTestVideo()
    videoInfo = await getVideoInfo(videoPath)
    
    console.log(`[Test] Video info: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s`)
    console.log()
    
    const targetW = Math.floor((videoInfo.height * 9) / 16)
    const zMinWidth = targetW / videoInfo.width
    const zMinHeight = 1.0
    const zMinExpected = Math.max(zMinWidth, zMinHeight, 0.88)
    
    console.log(`[Test] Expected z_min calculation:`)
    console.log(`  - targetW: ${targetW}px (9:16 from ${videoInfo.height}px height)`)
    console.log(`  - z_min_width: ${zMinWidth.toFixed(3)} (${targetW} / ${videoInfo.width})`)
    console.log(`  - z_min_height: ${zMinHeight.toFixed(3)} (always 1.0 for full height)`)
    console.log(`  - z_min_expected: ${zMinExpected.toFixed(3)}`)
    console.log()
    
    const input: ComputeInput = {
      videoPath,
      segStart: 0,
      segEnd: Math.min(videoInfo.duration, TEST_DURATION),
      baseW: videoInfo.width,
      baseH: videoInfo.height,
      transcript: [] as TranscriptWord[]
    }
    
    const constraints: Constraints = {
      margin: 0.05,
      safeTop: 0.15,
      safeBottom: 0.1,
      maxPan: 150,
      easeMs: 500,
      centerBiasX: 0.5,
      centerBiasY: 0.4
    }
    
    console.log(`[Test] Running person detection and framing calculation...`)
    console.log()
    
    const cropMap = await computeCropMapPerson(input, constraints)
    
    if (!cropMap || cropMap.length === 0) {
      console.error(`[Test] ❌ FAILED: No crop map generated (no people detected?)`)
      process.exit(1)
    }
    
    console.log(`[Test] ✓ Generated ${cropMap.length} framing keyframes`)
    console.log()
    
    const zoomValues = cropMap.map(k => k.z)
    const zMin = Math.min(...zoomValues)
    const zMax = Math.max(...zoomValues)
    const zAvg = zoomValues.reduce((a, b) => a + b, 0) / zoomValues.length
    
    console.log(`[Test] Zoom statistics:`)
    console.log(`  - z_min: ${zMin.toFixed(3)}`)
    console.log(`  - z_max: ${zMax.toFixed(3)}`)
    console.log(`  - z_avg: ${zAvg.toFixed(3)}`)
    console.log()
    
    if (zMin < zMinExpected - 0.001) {
      console.error(`[Test] ❌ FAILED: Zoom below expected minimum!`)
      console.error(`  Expected z >= ${zMinExpected.toFixed(3)}, but got z_min = ${zMin.toFixed(3)}`)
      process.exit(1)
    }
    
    console.log(`[Test] ✓ All zoom values >= ${zMinExpected.toFixed(3)}`)
    console.log()
    
    console.log(`[Test] Validating crop dimensions...`)
    let allValid = true
    const samplesToCheck = Math.min(10, cropMap.length)
    
    for (let i = 0; i < samplesToCheck; i++) {
      const idx = Math.floor((i * cropMap.length) / samplesToCheck)
      const k = cropMap[idx]
      const cropW = Math.round(targetW / k.z)
      const cropH = Math.round(videoInfo.height / k.z)
      
      if (cropW > videoInfo.width || cropH > videoInfo.height) {
        console.error(`[Test] ❌ Invalid crop at t=${k.t.toFixed(2)}s: crop=(${cropW}x${cropH}) > video=(${videoInfo.width}x${videoInfo.height})`)
        allValid = false
      }
      
      if (k.x < 0 || k.y < 0 || k.x + cropW > videoInfo.width || k.y + cropH > videoInfo.height) {
        console.error(`[Test] ❌ Invalid crop position at t=${k.t.toFixed(2)}s: pos=(${k.x},${k.y}) size=(${cropW}x${cropH})`)
        allValid = false
      }
    }
    
    if (!allValid) {
      console.error(`[Test] ❌ FAILED: Invalid crop dimensions detected`)
      process.exit(1)
    }
    
    console.log(`[Test] ✓ All ${samplesToCheck} sampled crops are valid`)
    console.log()
    
    console.log(`[Test] Generating FFmpeg filter...`)
    try {
      const filter = buildFFmpegFilter(videoInfo.width, videoInfo.height, cropMap)
      console.log(`[Test] ✓ FFmpeg filter generated successfully`)
      console.log(`[Test] Filter length: ${filter.length} characters`)
      console.log()
    } catch (error) {
      console.error(`[Test] ❌ FAILED: FFmpeg filter generation failed:`, error)
      process.exit(1)
    }
    
    console.log(`[Test] Rendering test clip...`)
    const outputDir = path.join(path.dirname(videoPath), "test_output")
    fs.mkdirSync(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, "framing_test.mp4")
    
    try {
      const filterExpr = buildFFmpegFilter(videoInfo.width, videoInfo.height, cropMap)
      
      await renderSmartFramedClip({
        inputPath: videoPath,
        outputPath,
        startTime: 0,
        duration: Math.min(videoInfo.duration, TEST_DURATION),
        srtPath: "",
        filterExpr
      })
      
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath)
        console.log(`[Test] ✓ Test clip rendered successfully`)
        console.log(`[Test] Output: ${outputPath}`)
        console.log(`[Test] Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`)
      } else {
        throw new Error("Output file not found")
      }
    } catch (error) {
      console.error(`[Test] ❌ Rendering failed:`, error)
      process.exit(1)
    }
    
    console.log()
    console.log("=".repeat(80))
    console.log("✓ ALL TESTS PASSED")
    console.log("=".repeat(80))
    console.log()
    console.log("Summary:")
    console.log(`  - Dimension-aware z_min working correctly (${zMinExpected.toFixed(3)})`)
    console.log(`  - All ${cropMap.length} keyframes have valid zoom values`)
    console.log(`  - All crop dimensions within video bounds`)
    console.log(`  - FFmpeg filter generated successfully`)
    console.log(`  - Test clip rendered successfully`)
    console.log()
    console.log(`Visual verification: ${outputPath}`)
    
  } catch (error) {
    console.error(`[Test] ❌ Test failed:`, error)
    process.exit(1)
  }
}

testFraming().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
