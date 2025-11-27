import { Queue, QueueOptions } from "bullmq"
import IORedis, { Redis } from "ioredis"

let redisInstance: Redis | null = null
let videoQueueInstance: Queue | null = null

export function connection() {
  if (!redisInstance) {
    const url = process.env.REDIS_URL || "redis://localhost:6379"

    redisInstance = new IORedis(url, {
      maxRetriesPerRequest: null
    })
  }

  return redisInstance
}

export function videoQueue() {
  if (!videoQueueInstance) {
    const queueOptions: QueueOptions = {
      connection: connection()
    }

    videoQueueInstance = new Queue("video.process", queueOptions)
  }

  return videoQueueInstance
}
