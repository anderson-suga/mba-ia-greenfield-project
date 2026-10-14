import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { Video } from '../entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { OUTBOX_STATUS } from './video-processing.types';
import type { VideoProcessingJob } from './video-processing.types';

@Injectable()
export class VideoProcessingOutboxService {
  constructor(
    @InjectRepository(VideoProcessingOutbox)
    private readonly outboxRepository: Repository<VideoProcessingOutbox>,
  ) {}

  /**
   * Records the intent to process a video, using the caller's `EntityManager` so
   * the row commits in the same transaction as the status change. If that
   * transaction rolls back, the event disappears with it — the video never leaves
   * `draft`, so no job is owed.
   */
  async enqueueInTransaction(
    manager: EntityManager,
    video: Video,
  ): Promise<VideoProcessingOutbox> {
    const eventId = randomUUID();
    const payload: Omit<VideoProcessingJob, 'event_id'> = {
      video_id: video.id,
      storage_key: video.storage_key,
    };

    return manager.save(
      manager.create(VideoProcessingOutbox, {
        event_id: eventId,
        video_id: video.id,
        status: OUTBOX_STATUS.PENDING,
        attempts: 0,
        payload: { ...payload },
        claimed_at: null,
        dispatched_at: null,
        processed_at: null,
        error_message: null,
      }),
    );
  }

  /** Marks the event as fully processed, once the worker has finished with it. */
  async markProcessed(eventId: string): Promise<void> {
    await this.outboxRepository.update(
      { event_id: eventId },
      { status: OUTBOX_STATUS.PROCESSED, processed_at: new Date() },
    );
  }

  /** Marks the event as terminally failed. The reason is recorded for diagnosis. */
  async markProcessedFailed(
    eventId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.outboxRepository.update(
      { event_id: eventId },
      {
        status: OUTBOX_STATUS.FAILED,
        processed_at: new Date(),
        error_message: errorMessage,
      },
    );
  }

  async findByEventId(eventId: string): Promise<VideoProcessingOutbox | null> {
    return this.outboxRepository.findOneBy({ event_id: eventId });
  }
}
