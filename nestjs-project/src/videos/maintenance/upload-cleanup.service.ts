import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, IsNull, Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS } from '../videos.constants';
import { STORAGE_SERVICE } from '../storage/storage.service';
import type { StorageService } from '../storage/storage.service';

export const UPLOAD_EXPIRED_ERROR_CODE = 'UPLOAD_EXPIRED';

/**
 * Cleans up abandoned uploads.
 *
 * MinIO purges incomplete multipart uploads on its own, but a `draft` row that
 * was never completed would otherwise sit in the database forever, indistinguishable
 * from an upload a user is still working on. This sweep gives that state a
 * terminal outcome and records why.
 */
@Injectable()
export class UploadCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadCleanupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(STORAGE_SERVICE)
    private readonly storage: StorageService,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  onModuleInit(): void {
    // Sweeps are driven explicitly in tests.
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
      await this.cleanupAbandonedUploads();
    } catch (error) {
      // A background loop must not take the process down.
      this.logger.error('Upload cleanup sweep failed', error as Error);
    }
  }

  /** Expires every draft untouched for longer than the retention window. */
  async cleanupAbandonedUploads(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.staleUploadHours * 60 * 60 * 1000,
    );

    const abandoned = await this.videoRepository.find({
      where: {
        status: VIDEO_STATUS.DRAFT,
        updated_at: LessThan(cutoff),
        upload_id: Not(IsNull()),
      },
    });

    let expired = 0;
    for (const video of abandoned) {
      // Best-effort: storage may already have dropped the upload itself.
      try {
        await this.storage.abortMultipartUpload(
          video.storage_key,
          video.upload_id!,
        );
      } catch (error) {
        this.logger.warn(
          `could not abort multipart upload for video ${video.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const result = await this.videoRepository.update(
        { id: video.id, status: VIDEO_STATUS.DRAFT },
        {
          status: VIDEO_STATUS.ERROR,
          error_code: UPLOAD_EXPIRED_ERROR_CODE,
          error_message: 'Upload was not completed within the retention window',
          upload_id: null,
        },
      );

      if ((result.affected ?? 0) > 0) {
        expired += 1;
        this.logger.log(
          `expired abandoned upload ${video.id} (last activity ${video.updated_at.toISOString()})`,
        );
      }
    }

    return expired;
  }
}
