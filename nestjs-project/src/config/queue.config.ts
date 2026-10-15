import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  /** Compose service name — never `localhost`. */
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  attempts: parseInt(process.env.QUEUE_ATTEMPTS || '3', 10),
  /** Base delay for exponential backoff: 30s, 2m, 10m across three attempts. */
  backoffMs: parseInt(process.env.QUEUE_BACKOFF_MS || '30000', 10),
  /**
   * Must exceed the longest expected job. Processing a large video with FFmpeg
   * can run for many minutes, so the lock is 30 minutes rather than BullMQ's
   * 30-second default, which would let a live job be re-delivered.
   */
  lockDurationMs: parseInt(process.env.QUEUE_LOCK_DURATION_MS || '1800000', 10),
  stalledIntervalMs: parseInt(
    process.env.QUEUE_STALLED_INTERVAL_MS || '60000',
    10,
  ),
  maxStalledCount: parseInt(process.env.QUEUE_MAX_STALLED_COUNT || '1', 10),
  /** Outbox relay poll interval and claim lease. */
  relayIntervalMs: parseInt(process.env.QUEUE_RELAY_INTERVAL_MS || '3000', 10),
  relayClaimLeaseMs: parseInt(
    process.env.QUEUE_RELAY_CLAIM_LEASE_MS || '60000',
    10,
  ),
  relayBatchSize: parseInt(process.env.QUEUE_RELAY_BATCH_SIZE || '25', 10),
  /** How often the cleanup and reconciler sweeps run. */
  maintenanceIntervalMs: parseInt(
    process.env.QUEUE_MAINTENANCE_INTERVAL_MS || '900000',
    10,
  ),
  /** A draft untouched for this long is abandoned and expires to `error`. */
  staleUploadHours: parseInt(process.env.QUEUE_STALE_UPLOAD_HOURS || '24', 10),
  /**
   * How long a video may sit in `processing` before it is considered stuck.
   * Sits above the worker's lock duration, so a live job is never reconciled.
   */
  stalledProcessingMs: parseInt(
    process.env.QUEUE_STALLED_PROCESSING_MS || '7200000',
    10,
  ),
}));
