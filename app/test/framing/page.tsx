"use client"

import { useState } from "react"
import { Box, Button, Typography, Paper, LinearProgress, Alert, Chip, TextField, Select, MenuItem, FormControl, InputLabel } from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import CancelIcon from "@mui/icons-material/Cancel"
import PlayArrowIcon from "@mui/icons-material/PlayArrow"

type ValidationResult = {
  test: string
  passed: boolean
  details: any
}

type TestResults = {
  video: {
    width: number
    height: number
    duration: number
  }
  globalCrop: {
    cropX: number
    cropY: number
    cropW: number
    cropH: number
    zMin: number
  } | null
  detection: {
    keyframes: number
    requestedDuration: number
    actualDuration: number
  }
  validations: ValidationResult[]
  output: {
    width: number
    height: number
    aspectRatio: string
    expectedAspectRatio: string
    valid: boolean
  }
  videos: {
    original: string
    framed: string
  }
}

export default function FramingTestPage() {
  const [testing, setTesting] = useState(false)
  const [results, setResults] = useState<TestResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState("https://www.youtube.com/watch?v=EngW7tLk6R8")
  const [durationMinutes, setDurationMinutes] = useState(3)
  const [progress, setProgress] = useState("")

  const runTest = async () => {
    setTesting(true)
    setError(null)
    setResults(null)
    setProgress("Step 1/3: Downloading video from YouTube...")

    const timer1 = setTimeout(() => {
      setProgress("Step 2/3: Running TinyFaceDetector on sampled frames...")
    }, 5000)

    const timer2 = setTimeout(() => {
      setProgress("Step 3/3: Computing two-speaker-aware crop and rendering output...")
    }, 15000)

    try {
      const response = await fetch("/api/test/framing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url,
          durationMinutes
        })
      })
      
      const data = await response.json()
      
      if (!data.success) {
        clearTimeout(timer1)
        clearTimeout(timer2)
        setError(data.error || "Test failed")
        setProgress("")
        return
      }

      clearTimeout(timer1)
      clearTimeout(timer2)
      setProgress("✓ Test completed successfully!")
      setResults(data.results)
    }
    catch (err: any) {
      clearTimeout(timer1)
      clearTimeout(timer2)
      setError(err.message || "Network error")
      setProgress("")
    }
    finally {
      setTesting(false)
    }
  }

  return (
    <Box sx={{ p: 4, maxWidth: 1400, mx: "auto" }}>
      <Typography variant="h4" gutterBottom>
        Smart Framing Test
      </Typography>
      
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Test the TinyFaceDetector + two-speaker-aware global crop with any YouTube video. 
        The system computes ONE static crop per video using face detection only and visualizes the 9:16 crop rectangle.
      </Typography>

      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Test Configuration
        </Typography>
        
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <TextField
            label="YouTube URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            fullWidth
            disabled={testing}
            placeholder="https://www.youtube.com/watch?v=..."
            helperText="Enter any YouTube video URL (interviews and talking heads work best)"
          />
          
          <FormControl fullWidth disabled={testing}>
            <InputLabel>Duration to Process</InputLabel>
            <Select
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value as number)}
              label="Duration to Process"
            >
              <MenuItem value={1}>1 minute</MenuItem>
              <MenuItem value={2}>2 minutes</MenuItem>
              <MenuItem value={3}>3 minutes (recommended)</MenuItem>
              <MenuItem value={4}>4 minutes</MenuItem>
              <MenuItem value={5}>5 minutes (max)</MenuItem>
            </Select>
          </FormControl>

          <Button
            variant="contained"
            size="large"
            onClick={runTest}
            disabled={testing || !url}
            startIcon={<PlayArrowIcon />}
            fullWidth
          >
            {testing ? "Testing..." : "Center Faces"}
          </Button>
        </Box>
      </Paper>

      {(testing || progress) && (
        <Paper sx={{ p: 3, mb: 4 }}>
          <Typography variant="h6" gutterBottom>
            {testing ? "Running Test..." : "Test Status"}
          </Typography>
          {testing && <LinearProgress sx={{ mb: 2 }} />}
          {progress && (
            <Typography variant="body2" color={progress.startsWith("✓") ? "success.main" : "text.secondary"}>
              {progress}
            </Typography>
          )}
          {testing && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
              This may take 30-120 seconds depending on video length and detection complexity
            </Typography>
          )}
        </Paper>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 4 }}>
          <Typography variant="h6">Test Failed</Typography>
          <Typography variant="body2">{error}</Typography>
        </Alert>
      )}

      {results && (
        <>
          {results.globalCrop && (
            <Paper sx={{ p: 3, mb: 4 }}>
              <Typography variant="h6" gutterBottom>
                Global Crop (TinyFaceDetector + Two-Speaker-Aware)
              </Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 2, mb: 3 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">Video Size</Typography>
                  <Typography variant="body1">{results.video.width}x{results.video.height}</Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">Crop Position</Typography>
                  <Typography variant="body1">({results.globalCrop.cropX}, {results.globalCrop.cropY})</Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">Crop Size</Typography>
                  <Typography variant="body1">{results.globalCrop.cropW}x{results.globalCrop.cropH}</Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">Zoom Factor</Typography>
                  <Typography variant="body1">{results.globalCrop.zMin.toFixed(2)}</Typography>
                </Box>
              </Box>
              
              <Typography variant="subtitle2" gutterBottom sx={{ mt: 2 }}>
                Crop Visualization
              </Typography>
              <Box sx={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
                <Box
                  component="video"
                  src={results.videos.original}
                  sx={{
                    width: "100%",
                    maxWidth: 800,
                    display: "block",
                    bgcolor: "black",
                    borderRadius: 1
                  }}
                />
                <Box
                  sx={{
                    position: "absolute",
                    left: `${(results.globalCrop.cropX / results.video.width) * 100}%`,
                    top: `${(results.globalCrop.cropY / results.video.height) * 100}%`,
                    width: `${(results.globalCrop.cropW / results.video.width) * 100}%`,
                    height: `${(results.globalCrop.cropH / results.video.height) * 100}%`,
                    border: "3px solid #ff0000",
                    pointerEvents: "none",
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)"
                  }}
                />
              </Box>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                Red rectangle shows the 9:16 crop area. This exact crop is used for all clips from this video.
              </Typography>
            </Paper>
          )}

          <Paper sx={{ p: 3, mb: 4 }}>
            <Typography variant="h6" gutterBottom>
              Detection Results
            </Typography>
            <Box sx={{ display: "flex", gap: 4 }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Keyframes Generated
                </Typography>
                <Typography variant="h5">{results.detection.keyframes}</Typography>
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Duration
                </Typography>
                <Typography variant="h5">{results.detection.actualDuration.toFixed(1)}s</Typography>
              </Box>
            </Box>
          </Paper>

          <Paper sx={{ p: 3, mb: 4 }}>
            <Typography variant="h6" gutterBottom>
              Validation Results
            </Typography>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {results.validations.map((validation, idx) => (
                <Box key={idx} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {validation.passed ? (
                    <CheckCircleIcon color="success" />
                  ) : (
                    <CancelIcon color="error" />
                  )}
                  <Typography variant="body1" sx={{ flex: 1 }}>
                    {validation.test}
                  </Typography>
                  {validation.details && (
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                      {Object.entries(validation.details).map(([key, value]) => (
                        <Chip
                          key={key}
                          label={`${key}: ${value}`}
                          size="small"
                          variant="outlined"
                        />
                      ))}
                    </Box>
                  )}
                </Box>
              ))}
              
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                {results.output.valid ? (
                  <CheckCircleIcon color="success" />
                ) : (
                  <CancelIcon color="error" />
                )}
                <Typography variant="body1" sx={{ flex: 1 }}>
                  Output aspect ratio validation
                </Typography>
                <Chip
                  label={`${results.output.width}x${results.output.height}`}
                  size="small"
                  variant="outlined"
                />
                <Chip
                  label={`Ratio: ${results.output.aspectRatio}`}
                  size="small"
                  variant="outlined"
                />
              </Box>
            </Box>
          </Paper>

          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Video Comparison
            </Typography>
            <Box sx={{ display: "flex", flexDirection: { xs: "column", md: "row" }, gap: 3 }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle1" gutterBottom>
                  Original 16:9
                </Typography>
                <Box
                  component="video"
                  src={results.videos.original}
                  controls
                  sx={{
                    width: "100%",
                    maxHeight: 400,
                    bgcolor: "black",
                    borderRadius: 1
                  }}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle1" gutterBottom>
                  Framed 9:16
                </Typography>
                <Box
                  component="video"
                  src={results.videos.framed}
                  controls
                  sx={{
                    width: "100%",
                    maxHeight: 400,
                    bgcolor: "black",
                    borderRadius: 1
                  }}
                />
              </Box>
            </Box>
          </Paper>
        </>
      )}
    </Box>
  )
}
