import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/src/lib/session'
import { prisma } from '@/src/lib/prisma'
import { videoQueue } from '@/src/lib/queue'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAuth()
    const { id } = params
    
    const video = await prisma.video.findUnique({
      where: { id, userId: session.userId }
    })
    
    if (!video)
    {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }
    
    if (video.status === 'completed')
    {
      return NextResponse.json({ error: 'Video already completed' }, { status: 400 })
    }
    
    const job = await videoQueue().getJob(id)
    
    if (job)
    {
      await job.remove()
    }
    
    await prisma.video.update({
      where: { id },
      data: { status: 'queued' }
    })
    
    await videoQueue().add('process', {
      videoId: video.id,
      userId: session.userId
    })
    
    return NextResponse.json({ success: true, status: 'queued' })
  }
  catch (error) {
    console.error('Error retrying video:', error)
    return NextResponse.json({ error: 'Failed to retry video' }, { status: 500 })
  }
}
