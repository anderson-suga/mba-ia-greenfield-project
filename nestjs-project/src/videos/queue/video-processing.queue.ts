import type { JobsOptions, WorkerOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_JOB = 'video.process';

/** Defaults for the values below; `queue.config.ts` reads the same env keys at runtime. */
const DEFAULT_LOCK_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_STALLED_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_STALLED_COUNT = 1;

/**
 * Worker options are read by the `@Processor` decorator, which is evaluated when
 * this module is imported — before `ConfigModule` has loaded `.env`. They are
 * therefore resolved from the process environment here rather than injected.
 *
 * `lockDuration` is deliberately far above BullMQ's 30-second default: rendering a
 * thumbnail from a 10GB source can run for minutes, and a lock that expires
 * mid-job would let a second worker start the same video.
 */
export const VIDEO_PROCESSING_WORKER_OPTIONS: Omit<
  WorkerOptions,
  'connection'
> = {
  lockDuration: Number(
    process.env.QUEUE_LOCK_DURATION_MS ?? DEFAULT_LOCK_DURATION_MS,
  ),
  stalledInterval: Number(
    process.env.QUEUE_STALLED_INTERVAL_MS ?? DEFAULT_STALLED_INTERVAL_MS,
  ),
  maxStalledCount: Number(
    process.env.QUEUE_MAX_STALLED_COUNT ?? DEFAULT_MAX_STALLED_COUNT,
  ),
  /** FFmpeg saturates the CPU; one video at a time per worker container. */
  concurrency: 1,
};

export interface VideoJobSettings {
  attempts: number;
  /** Base delay for the exponential backoff (30s, 2m, 10m across three attempts). */
  backoffMs: number;
}

/**
 * Job options for `video.process`.
 *
 * `jobId` is the outbox `event_id`: BullMQ ignores an add whose `jobId` already
 * exists, which is what makes a repeated relay dispatch a no-op.
 */
export function buildVideoProcessingJobOptions(
  settings: VideoJobSettings,
  eventId: string,
): JobsOptions {
  return {
    jobId: eventId,
    attempts: settings.attempts,
    backoff: { type: 'exponential', delay: settings.backoffMs },
    removeOnComplete: { age: 60 * 60, count: 1000 },
    removeOnFail: { age: 24 * 60 * 60 },
  };
}
