import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS, buildThumbnailStorageKey } from '../videos.constants';
import { STORAGE_SERVICE } from '../storage/storage.service';
import type { StorageService } from '../storage/storage.service';
import { VideoProcessingOutboxService } from '../queue/video-processing-outbox.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_WORKER_OPTIONS,
} from '../queue/video-processing.queue';
import type { VideoProcessingJob } from '../queue/video-processing.types';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';
import { truncateStderr } from './ffmpeg.types';
import {
  INVALID_MEDIA_ERROR_CODE,
  PROCESSING_FAILED_ERROR_CODE,
  isUnrecoverable,
} from './failure-policy';

@Processor(VIDEO_PROCESSING_QUEUE, VIDEO_PROCESSING_WORKER_OPTIONS)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(STORAGE_SERVICE)
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
    private readonly thumbnail: ThumbnailService,
    private readonly outbox: VideoProcessingOutboxService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJob>): Promise<void> {
    const { video_id: videoId, event_id: eventId } = job.data;

    // The payload is only a pointer; the row is the source of truth. Re-reading it
    // is what makes redelivery and duplicate jobs safe.
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video) {
      this.logger.warn(`job ${job.id} references unknown video ${videoId}`);
      return;
    }

    if (video.status !== VIDEO_STATUS.PROCESSING) {
      // Already finished, already failed, or aborted while queued. Completing the
      // job is correct: there is nothing left to do and nothing to retry.
      this.logger.log(
        `skipping video ${videoId}: status is ${video.status}, not processing`,
      );
      return;
    }

    await job.updateProgress(10);

    // `internal: true` is mandatory — a container resolving the public endpoint
    // would reach itself and fail with ECONNREFUSED.
    const inputUrl = await this.storage.getPresignedReadUrl(video.storage_key, {
      internal: true,
    });

    try {
      const probe = await this.mediaProbe.probe(inputUrl);
      await job.updateProgress(40);

      const image = await this.thumbnail.generate(
        inputUrl,
        probe.durationSeconds ?? 0,
      );
      await job.updateProgress(70);

      const thumbnailKey = buildThumbnailStorageKey(video.id);
      await this.storage.putObject(thumbnailKey, image, 'image/jpeg');

      // `ready` is only ever written once the thumbnail is confirmed to exist;
      // publishing a video whose poster frame is missing is worse than a retry.
      const head = await this.storage.headObject(thumbnailKey);
      if (head.size === 0) {
        throw new Error('thumbnail was written but is empty');
      }
      await job.updateProgress(90);

      await this.videoRepository.update(
        { id: video.id, status: VIDEO_STATUS.PROCESSING },
        {
          status: VIDEO_STATUS.READY,
          duration_seconds: probe.durationSeconds,
          // TypeORM's deep-partial type does not accept a plain object for a
          // jsonb column, so the probe result is bridged here.
          metadata: probe.metadata as never,
          thumbnail_key: thumbnailKey,
          mime_type: video.mime_type,
        },
      );

      await this.outbox.markProcessed(eventId);

      await job.updateProgress(100);
      this.logger.log(`video ${video.id} is ready`);
    } catch (error) {
      if (isUnrecoverable(error)) {
        await this.recordTerminalError(
          video.id,
          eventId,
          INVALID_MEDIA_ERROR_CODE,
          error,
        );

        // Marks the job failed without consuming the remaining attempts: the same
        // bytes would fail identically every time.
        throw new UnrecoverableError(
          error instanceof Error ? error.message : 'invalid media',
        );
      }

      // Recoverable: let BullMQ retry with backoff.
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJob>, error: Error): Promise<void> {
    const attemptsAllowed = job.opts.attempts ?? 1;

    // `failed` fires on every unsuccessful attempt; the terminal state is only
    // owed once the attempts are actually exhausted.
    if (job.attemptsMade < attemptsAllowed) {
      return;
    }

    await this.recordTerminalError(
      job.data.video_id,
      job.data.event_id,
      PROCESSING_FAILED_ERROR_CODE,
      error,
    );
  }

  /**
   * Records the terminal state, but only if the video is still processing — a
   * video already marked `error` by the unrecoverable path (or advanced to
   * `ready` by a concurrent attempt) must not be overwritten.
   */
  private async recordTerminalError(
    videoId: string,
    eventId: string,
    errorCode: string,
    error: unknown,
  ): Promise<void> {
    const message = truncateStderr(
      error instanceof Error ? error.message : String(error),
    );

    const result = await this.videoRepository.update(
      { id: videoId, status: VIDEO_STATUS.PROCESSING },
      {
        status: VIDEO_STATUS.ERROR,
        error_code: errorCode,
        error_message: message,
      },
    );

    if ((result.affected ?? 0) > 0) {
      await this.outbox.markProcessedFailed(eventId, message);
      this.logger.error(
        `video ${videoId} failed with ${errorCode}: ${message}`,
      );
    }
  }
}
