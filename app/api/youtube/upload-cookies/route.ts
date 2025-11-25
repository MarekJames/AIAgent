import { NextResponse } from 'next/server'
import { getSession } from '@/src/lib/session'
import { saveCookies } from '@/src/services/cookieGenerator'

function validateNetscapeCookieFormat(content: string): { valid: boolean; error?: string } {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  
  if (lines.length === 0) {
    return { valid: false, error: 'Cookie file is empty' }
  }

  const hasNetscapeHeader = lines.some(line => 
    line.toLowerCase().includes('netscape') && line.toLowerCase().includes('cookie')
  )
  
  const cookieLines = lines.filter(line => {
    if (line.startsWith('#HttpOnly_')) {
      return true
    }
    if (line.startsWith('#')) {
      return false
    }
    return true
  })
  
  if (cookieLines.length === 0) {
    return { valid: false, error: 'No cookie entries found. Make sure to paste the raw Netscape format cookies, not encrypted or base64 encoded data.' }
  }

  let validCookieCount = 0
  for (const line of cookieLines) {
    const cookieLine = line.startsWith('#HttpOnly_') ? line.substring('#HttpOnly_'.length) : line
    const parts = cookieLine.split('\t')
    
    if (parts.length >= 6) {
      validCookieCount++
    }
  }

  if (validCookieCount === 0) {
    return { 
      valid: false, 
      error: 'Invalid cookie format. Cookies must be in Netscape format with tab-separated values. Make sure you exported cookies as plain text, not encrypted data.' 
    }
  }

  const hasYouTubeCookie = lines.some(line => line.includes('youtube.com'))
  if (!hasYouTubeCookie) {
    return { 
      valid: false, 
      error: 'No YouTube cookies found. Make sure you export cookies from youtube.com while logged in.' 
    }
  }

  if (!hasNetscapeHeader) {
    console.warn('Cookie file missing Netscape header comment, but cookies appear valid')
  }

  return { valid: true }
}

export async function POST(request: Request) {
  const session = await getSession()
  
  if (!session.isAuthenticated || !session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { cookies: cookieContent } = body

    if (!cookieContent || typeof cookieContent !== 'string') {
      return NextResponse.json(
        { error: 'Cookie content is required' },
        { status: 400 }
      )
    }

    if (cookieContent.trim().length === 0) {
      return NextResponse.json(
        { error: 'Cookie content cannot be empty' },
        { status: 400 }
      )
    }

    const validation = validateNetscapeCookieFormat(cookieContent)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      )
    }

    await saveCookies(session.userId, cookieContent)

    return NextResponse.json({ success: true })
  }
  catch (error: any) {
    console.error('Error uploading YouTube cookies:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to upload cookies' },
      { status: 500 }
    )
  }
}
