import type { JobState, JobStatus, ProcessMode, CropInfo, Job, InsertJob } from "@shared/schema";
import { jobs } from "@shared/schema";
import { db } from "../db";
import { eq, and, lt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export class JobManager {
  private readonly TMP_DIR = path.join(process.cwd(), "tmp");
  private readonly FRAMES_DIR = path.join(process.cwd(), "tmp/frames");

  async initialize() {
    await fs.mkdir(this.TMP_DIR, { recursive: true });
    await fs.mkdir(this.FRAMES_DIR, { recursive: true });
  }

  private dbJobToState(job: Job): JobState {
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      url: job.url,
      startSeconds: job.startSeconds,
      mode: job.mode,
      errorMessage: job.errorMessage || undefined,
      downloadPath: job.downloadPath || undefined,
      debugImagePath: job.debugImagePath || undefined,
      framesAnalyzed: job.framesAnalyzed || undefined,
      crop: job.crop || undefined,
      createdAt: job.createdAt.getTime(),
    };
  }

  async createJob(url: string, startSeconds: number, mode: ProcessMode): Promise<JobState> {
    const id = randomUUID();
    const [job] = await db
      .insert(jobs)
      .values({
        id,
        url,
        startSeconds,
        mode,
        status: "pending",
        progress: 0,
      })
      .returning();
    return this.dbJobToState(job);
  }

  async getJob(id: string): Promise<JobState | undefined> {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    return job ? this.dbJobToState(job) : undefined;
  }

  async updateJob(id: string, updates: Partial<InsertJob>): Promise<void> {
    await db
      .update(jobs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(jobs.id, id));
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await this.updateJob(id, { progress: Math.floor(Math.min(100, Math.max(0, progress))) });
  }

  async setStatus(id: string, status: JobStatus, errorMessage?: string): Promise<void> {
    await this.updateJob(id, { status, errorMessage });
  }

  async setCrop(id: string, crop: CropInfo): Promise<void> {
    await this.updateJob(id, { crop });
  }

  async setFramesAnalyzed(id: string, count: number): Promise<void> {
    await this.updateJob(id, { framesAnalyzed: count });
  }

  async setDownloadPath(id: string, downloadPath: string): Promise<void> {
    await this.updateJob(id, { downloadPath });
  }

  async setDebugImagePath(id: string, debugImagePath: string): Promise<void> {
    await this.updateJob(id, { debugImagePath });
  }

  async isJobCancelled(id: string): Promise<boolean> {
    const job = await this.getJob(id);
    return job?.status === "cancelled";
  }

  async cleanupJob(id: string): Promise<void> {
    try {
      const inputPath = path.join(this.TMP_DIR, `input-${id}.mp4`);
      const outputPath = path.join(this.TMP_DIR, `output-${id}.mp4`);
      const debugPath = path.join(this.TMP_DIR, `debug-${id}.png`);

      const removeIfExists = async (filePath: string) => {
        try {
          await fs.unlink(filePath);
        } catch (err: any) {
          if (err.code !== "ENOENT") {
            console.error(`Error removing ${filePath}:`, err);
          }
        }
      };

      await removeIfExists(inputPath);
      await removeIfExists(outputPath);
      await removeIfExists(debugPath);

      const files = await fs.readdir(this.FRAMES_DIR);
      const jobFrames = files.filter(f => f.startsWith(`${id}-frame-`));
      await Promise.all(
        jobFrames.map(f => removeIfExists(path.join(this.FRAMES_DIR, f)))
      );
    } catch (err) {
      console.error(`Error cleaning up job ${id}:`, err);
    }
  }

  async cleanupOldJobs(maxAgeMs: number = 30 * 60 * 1000): Promise<void> {
    const cutoffDate = new Date(Date.now() - maxAgeMs);
    const oldJobs = await db
      .select()
      .from(jobs)
      .where(
        and(
          lt(jobs.createdAt, cutoffDate),
          eq(jobs.status, "done" as JobStatus)
        )
      );

    for (const job of oldJobs) {
      await this.cleanupJob(job.id);
      await db.delete(jobs).where(eq(jobs.id, job.id));
    }
  }

  getInputPath(jobId: string): string {
    return path.join(this.TMP_DIR, `input-${jobId}.mp4`);
  }

  getOutputPath(jobId: string): string {
    return path.join(this.TMP_DIR, `output-${jobId}.mp4`);
  }

  getDebugPath(jobId: string): string {
    return path.join(this.TMP_DIR, `debug-${jobId}.png`);
  }

  getFramesDir(): string {
    return this.FRAMES_DIR;
  }

  getFramePath(jobId: string, frameNumber: number): string {
    return path.join(this.FRAMES_DIR, `${jobId}-frame-${frameNumber.toString().padStart(4, '0')}.png`);
  }
}

export const jobManager = new JobManager();
