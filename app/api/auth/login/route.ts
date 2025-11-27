import { NextResponse } from 'next/server'
import { getSession } from '@/src/lib/session'
import { checkYouTubeConnection } from '@/src/lib/youtube-client'

export async function POST() {
  try {
    const youtubeConnected = await checkYouTubeConnection()
    
    if (!youtubeConnected)
    {
      return NextResponse.json(
        { error: 'YouTube connection not configured. Please set up the YouTube connector first.' },
        { status: 401 }
      )
    }
    
    const session = await getSession()
    session.isAuthenticated = true
    session.userId = 'youtube_user'
    await session.save()
    
    return NextResponse.json({ success: true })
  }
  catch (error) {
    return NextResponse.json(
      { error: 'Failed to authenticate with YouTube' },
      { status: 500 }
    )
  }
}
