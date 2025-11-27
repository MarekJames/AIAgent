import { NextResponse } from 'next/server'
import { getSession } from '@/src/lib/session'
import { checkYouTubeConnection } from '@/src/lib/youtube-client'

export async function GET() {
  try {
    const session = await getSession()
    const youtubeConnected = await checkYouTubeConnection()
    
    return NextResponse.json({
      isAuthenticated: session.isAuthenticated || false,
      youtubeConnected,
      email: session.email || null
    })
  }
  catch (error) {
    return NextResponse.json({
      isAuthenticated: false,
      youtubeConnected: false,
      email: null
    })
  }
}
