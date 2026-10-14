/**
 * Payload of a `video.process` job.
 *
 * This is a **pointer, not a document**: the consumer re-reads the `videos` row by
 * `video_id` and never trusts these fields for state, so a stale or replayed
 * payload cannot cause stale processing.
 */
export interface VideoProcessingJob {
  /** Internal UUID of the video to process. */
  video_id: string;
  /** `videos/{video_id}/source.mp4` — the object the worker reads. */
  storage_key: string;
  /** `event_id` of the outbox row; equal to the BullMQ `jobId`. */
  event_id: string;
}

export const OUTBOX_STATUS = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  PROCESSED: 'processed',
  FAILED: 'failed',
} as const;

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];
