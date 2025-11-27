import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/src/lib/session'
import { prisma } from '@/src/lib/prisma'
import { encrypt } from '@/src/lib/encryption'

function validateCookies(cookiesText: string): boolean {
  const lines = cookiesText.split('\n').filter(line => line.trim() && !line.startsWith('#'))
  
  if (lines.length === 0)
  {
    return false
  }
  
  const requiredCookies = ['SAPISID', 'HSID', 'SSID']
  const foundCookies = new Set<string>()
  
  for (const line of lines)
  {
    const parts = line.split('\t')
    
    if (parts.length < 7)
    {
      continue
    }
    
    const cookieName = parts[5]
    
    if (requiredCookies.includes(cookieName))
    {
      foundCookies.add(cookieName)
    }
  }
  
  return requiredCookies.every(cookie => foundCookies.has(cookie))
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireAuth()
    
    if (!session.userId)
    {
      return NextResponse.json(
        { error: 'User ID not found in session' },
        { status: 401 }
      )
    }
    
    const contentType = request.headers.get('content-type') || ''
    let cookiesText: string
    
    if (contentType.includes('multipart/form-data'))
    {
      const formData = await request.formData()
      const file = formData.get('file') as File
      
      if (!file)
      {
        return NextResponse.json(
          { error: 'No file provided' },
          { status: 400 }
        )
      }
      
      cookiesText = await file.text()
    }
    else
    {
      const body = await request.json()
      cookiesText = body.cookies
      
      if (!cookiesText)
      {
        return NextResponse.json(
          { error: 'No cookies provided' },
          { status: 400 }
        )
      }
    }
    
    if (!validateCookies(cookiesText))
    {
      return NextResponse.json(
        { error: 'Invalid cookies format or missing required cookies (SAPISID, HSID, SSID)' },
        { status: 400 }
      )
    }
    
    const user = await prisma.user.findUnique({
      where: { id: session.userId }
    })
    
    if (!user)
    {
      return NextResponse.json(
        { error: 'User not found. Please sign in again.' },
        { status: 404 }
      )
    }
    
    const encryptedCookies = encrypt(cookiesText)
    
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        youtubeCookies: encryptedCookies,
        youtubeCookiesCreatedAt: new Date(),
        youtubeCookiesLastUsedAt: new Date()
      }
    })
    
    return NextResponse.json({ success: true })
  }
  catch (error: any) {
    console.error('Error saving cookies:', error)
    
    if (error.message === 'Authentication required')
    {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }
    
    return NextResponse.json(
      { error: 'Failed to save cookies' },
      { status: 500 }
    )
  }
}
