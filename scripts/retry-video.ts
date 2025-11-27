import { videoQueue } from '../src/lib/queue'

const videoId = process.argv[2]
const userId = process.argv[3]

if (!videoId || !userId)
{
  console.error('Usage: ts-node scripts/retry-video.ts <videoId> <userId>')
  process.exit(1)
}

async function retry() {
  try {
    await videoQueue().add('process', {
      videoId,
      userId
    })
    console.log(`Job added to queue for video ${videoId}`)
    process.exit(0)
  }
  catch (error) {
    console.error('Error adding job:', error)
    process.exit(1)
  }
}

retry()
