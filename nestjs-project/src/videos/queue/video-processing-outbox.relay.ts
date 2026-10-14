import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import {
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE,
  buildVideoProcessingJobOptions,
} from './video-processing.queue';
import { OUTBOX_STATUS } from './video-processing.types';
import type { VideoProcessingJob } from './video-processing.types';

/** Dispatch attempts before a row is considered undeliverable. */
export const MAX_DISPATCH_ATTEMPTS = 5;

@Injectable()
export class VideoProcessingOutboxRelay
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(VideoProcessingOutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly dataSource: DataSource,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  onModuleInit(): void {
    // Tests dispatch by calling processPending() directly, so the timer would only
    // add nondeterminism and slow suites down.
    if (process.env.NODE_ENV === 'test') return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.relayIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.processPending();
    } catch (error) {
      // A background loop must not take the process down; the rows stay `pending`
      // and the next tick retries them.
      this.logger.error('Outbox relay tick failed', error as Error);
    }
  }

  /**
   * Publishes every claimable pending row and returns how many were dispatched.
   *
   * Claiming is a single `UPDATE ... FOR UPDATE SKIP LOCKED`, so two relays — or
   * two instances of the API — can run this concurrently without ever taking the
   * same row. The lease (`claimed_at`) means a relay that dies mid-tick does not
   * strand its rows: they become claimable again once the lease expires.
   */
  async processPending(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;

    try {
      const leaseCutoff = new Date(Date.now() - this.config.relayClaimLeaseMs);

      // TypeORM returns `[rows, affectedCount]` for UPDATE/DELETE, unlike SELECT —
      // so the rows are the first element, not the result itself.
      const [claimed] = await this.dataSource.query<
        [VideoProcessingOutbox[], number]
      >(
        `UPDATE "video_processing_outbox" AS outbox
            SET "claimed_at" = now()
          WHERE outbox."id" IN (
                  SELECT "id"
                    FROM "video_processing_outbox"
                   WHERE "status" = $1
                     AND ("claimed_at" IS NULL OR "claimed_at" < $2)
                   ORDER BY "created_at"
                   LIMIT $3
                     FOR UPDATE SKIP LOCKED
                )
        RETURNING outbox.*`,
        [OUTBOX_STATUS.PENDING, leaseCutoff, this.config.relayBatchSize],
      );

      let dispatched = 0;
      for (const row of claimed) {
        if (await this.dispatch(row)) dispatched += 1;
      }

      return dispatched;
    } finally {
      this.inFlight = false;
    }
  }

  private async dispatch(row: VideoProcessingOutbox): Promise<boolean> {
    const attemptsMade = row.attempts + 1;

    try {
      // `jobId` is the outbox `event_id`: re-publishing an event BullMQ already
      // holds is a no-op, so an orphaned row re-dispatched after a crash cannot
      // produce a second job.
      await this.queue.add(
        VIDEO_PROCESSING_JOB,
        row.payload as unknown as VideoProcessingJob,
        buildVideoProcessingJobOptions(this.config, row.event_id),
      );

      await this.dataSource.query(
        `UPDATE "video_processing_outbox"
            SET "status" = $2, "attempts" = $3, "dispatched_at" = now(),
                "claimed_at" = NULL, "error_message" = NULL
          WHERE "id" = $1`,
        [row.id, OUTBOX_STATUS.DISPATCHED, attemptsMade],
      );

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attemptsMade >= MAX_DISPATCH_ATTEMPTS;

      await this.dataSource.query(
        `UPDATE "video_processing_outbox"
            SET "status" = $2, "attempts" = $3, "claimed_at" = NULL,
                "error_message" = $4
          WHERE "id" = $1`,
        [
          row.id,
          exhausted ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING,
          attemptsMade,
          message,
        ],
      );

      if (exhausted) {
        this.logger.error(
          `Outbox event ${row.event_id} for video ${row.video_id} could not be dispatched after ${attemptsMade} attempts: ${message}`,
        );
      }

      return false;
    }
  }
}
