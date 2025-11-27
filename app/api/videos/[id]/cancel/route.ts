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
    
    if (video.status !== 'processing')
    {
      return NextResponse.json({ error: 'Video is not processing' }, { status: 400 })
    }
    
    const job = await videoQueue().getJob(id)
    
    if (job)
    {
      await job.remove()
    }
    
    await prisma.video.update({
      where: { id },
      data: { status: 'cancelled' }
    })
    
    return NextResponse.json({ success: true })
  }
  catch (error) {
    console.error('Error cancelling video:', error)
    return NextResponse.json({ error: 'Failed to cancel video' }, { status: 500 })
  }
}
