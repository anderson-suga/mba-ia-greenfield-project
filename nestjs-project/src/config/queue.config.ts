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
}));
