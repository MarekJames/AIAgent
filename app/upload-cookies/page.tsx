"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import {
  Container,
  Paper,
  Typography,
  TextField,
  Button,
  Alert,
  Box,
  Link as MuiLink,
  Stack,
} from "@mui/material"

export default function UploadCookiesPage() {
  const router = useRouter()
  const [cookies, setCookies] = useState("")
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    checkAuth()
  }, [])

  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/status")
      const data = await res.json()
      if (!data.isAuthenticated) {
        router.push("/login")
        return
      }
      setAuthChecked(true)
    }
    catch {
      router.push("/login")
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    setUploading(true)
    setError("")
    setSuccess(false)

    try {
      const res = await fetch("/api/youtube/upload-cookies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies }),
      })

      if (res.ok) {
        setSuccess(true)
        setCookies("")
        setTimeout(() => {
          router.push("/")
        }, 2000)
      }
      else {
        const data = await res.json()
        setError(data.error || "Failed to upload cookies")
      }
    }
    catch (err) {
      setError("Failed to upload cookies")
    }
    finally {
      setUploading(false)
    }
  }

  if (!authChecked) {
    return null
  }

  return (
    <Container maxWidth="md" sx={{ py: 8 }}>
      <Paper sx={{ p: 4 }}>
        <Typography variant="h4" gutterBottom>
          Upload YouTube Cookies
        </Typography>
        
        <Alert severity="info" sx={{ mb: 2 }}>
          YouTube requires cookies for authentication. Cookies typically last 2-3 weeks before needing to be refreshed.
        </Alert>

        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>Important:</strong> Cookies must be in plain text Netscape format (tab-separated values), not encrypted or base64 encoded.
        </Alert>

        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            How to export YouTube cookies:
          </Typography>
          <Stack spacing={1} sx={{ ml: 2 }}>
            <Typography variant="body2">
              1. Install a cookie export extension for your browser:
            </Typography>
            <Typography variant="body2" sx={{ ml: 2 }}>
              • Chrome/Edge: <MuiLink href="https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank">Get cookies.txt LOCALLY</MuiLink>
            </Typography>
            <Typography variant="body2" sx={{ ml: 2 }}>
              • Firefox: <MuiLink href="https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/" target="_blank">cookies.txt</MuiLink>
            </Typography>
            <Typography variant="body2">
              2. Log into YouTube in your browser
            </Typography>
            <Typography variant="body2">
              3. Go to youtube.com, click the extension icon, and export cookies
            </Typography>
            <Typography variant="body2">
              4. Open the downloaded .txt file and copy ALL contents
            </Typography>
            <Typography variant="body2">
              5. Paste the entire content into the box below
            </Typography>
          </Stack>
        </Box>

        <Box sx={{ mb: 3, p: 2, bgcolor: 'grey.900', borderRadius: 1 }}>
          <Typography variant="subtitle2" gutterBottom color="warning.main">
            Expected Format Example:
          </Typography>
          <Typography 
            variant="body2" 
            sx={{ 
              fontFamily: 'monospace', 
              fontSize: '0.75rem',
              color: 'grey.400',
              whiteSpace: 'pre'
            }}
          >
{`# Netscape HTTP Cookie File
.youtube.com    TRUE    /       TRUE    1234567890      VISITOR_INFO1_LIVE      xxx
#HttpOnly_.youtube.com  TRUE    /       TRUE    1234567890      LOGIN_INFO      yyy`}
          </Typography>
          <Typography variant="caption" color="grey.500" sx={{ mt: 1, display: 'block' }}>
            Note: Cookie values are separated by TAB characters, not spaces.
          </Typography>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {success && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Cookies uploaded successfully! Redirecting to dashboard...
          </Alert>
        )}

        <form onSubmit={handleUpload}>
          <TextField
            fullWidth
            multiline
            rows={12}
            variant="outlined"
            label="Paste YouTube cookies here (Netscape format)"
            value={cookies}
            onChange={(e) => setCookies(e.target.value)}
            placeholder="# Netscape HTTP Cookie File&#10;.youtube.com   TRUE    /       TRUE    0       VISITOR_INFO1_LIVE      ...&#10;.youtube.com    TRUE    /       TRUE    0       LOGIN_INFO      ..."
            disabled={uploading}
            sx={{ mb: 2, fontFamily: "monospace" }}
          />
          
          <Stack direction="row" spacing={2}>
            <Button
              type="submit"
              variant="contained"
              disabled={!cookies.trim() || uploading}
            >
              {uploading ? "Uploading..." : "Upload Cookies"}
            </Button>
            <Button
              variant="outlined"
              onClick={() => router.push("/")}
              disabled={uploading}
            >
              Cancel
            </Button>
          </Stack>
        </form>
      </Paper>
    </Container>
  )
}
