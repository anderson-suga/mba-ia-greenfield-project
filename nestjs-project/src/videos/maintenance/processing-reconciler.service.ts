import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS } from '../videos.constants';
import { VideoProcessingOutbox } from '../queue/entities/video-processing-outbox.entity';
import { VideoProcessingOutboxService } from '../queue/video-processing-outbox.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';

export const PROCESSING_STALLED_ERROR_CODE = 'PROCESSING_STALLED';

/** Re-enqueue attempts before a stuck video is written off. */
export const MAX_RECONCILE_ATTEMPTS = 3;

/** BullMQ states that mean a worker still owns the job. */
const LIVE_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'waiting-children',
]);

/**
 * Reconciles videos that are stuck in `processing`.
 *
 * The database and the queue are consulted together, because either one alone
 * lies: a row in `processing` may have no job at all (the dispatch was lost), and
 * a job may exist for a row that a redelivery already finished. A video is only
 * touched once no live job can account for it.
 */
@Injectable()
export class ProcessingReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProcessingReconcilerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(VideoProcessingOutbox)
    private readonly outboxRepository: Repository<VideoProcessingOutbox>,
    private readonly outboxService: VideoProcessingOutboxService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;

    this.timer = setInterval(() => {
      void this.sweep();
    }, this.config.maintenanceIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweep(): Promise<void> {
    try {
      await this.reconcileStalledProcessing();
    } catch (error) {
      this.logger.error('Processing reconciler sweep failed', error as Error);
    }
  }

  /**
   * Returns how many videos were acted on: re-enqueued or moved to `error`.
   */
  async reconcileStalledProcessing(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.stalledProcessingMs);

    const stalled = await this.videoRepository.find({
      where: {
        status: VIDEO_STATUS.PROCESSING,
        updated_at: LessThan(cutoff),
      },
    });

    let reconciled = 0;
    for (const video of stalled) {
      if (await this.hasLiveJob(video.id)) {
        // Still running — the lock duration is below the stalled threshold, so a
        // live job means the worker is simply taking its time.
        continue;
      }

      const attempts = await this.outboxRepository.countBy({
        video_id: video.id,
      });

      if (attempts < MAX_RECONCILE_ATTEMPTS) {
        await this.requeue(video);
        this.logger.warn(
          `re-enqueued stalled video ${video.id} (attempt ${attempts + 1})`,
        );
      } else {
        await this.markStalled(video);
        this.logger.error(
          `video ${video.id} is stalled after ${attempts} dispatch attempts`,
        );
      }

      reconciled += 1;
    }

    return reconciled;
  }

  private async hasLiveJob(videoId: string): Promise<boolean> {
    const events = await this.outboxRepository.findBy({ video_id: videoId });

    for (const event of events) {
      const job = await this.queue.getJob(event.event_id);
      if (!job) continue;

      const state = await job.getState();
      if (LIVE_JOB_STATES.has(state)) return true;
    }

    return false;
  }

  private async requeue(video: Video): Promise<void> {
    // A fresh event id means a fresh job; the processor's guard makes the
    // duplicate harmless if the original turns out to still be alive.
    await this.outboxService.enqueueInTransaction(
      this.videoRepository.manager,
      video,
    );
  }

  private async markStalled(video: Video): Promise<void> {
    await this.videoRepository.update(
      { id: video.id, status: VIDEO_STATUS.PROCESSING },
      {
        status: VIDEO_STATUS.ERROR,
        error_code: PROCESSING_STALLED_ERROR_CODE,
        error_message: 'Processing stalled with no active job',
      },
    );
  }
}
