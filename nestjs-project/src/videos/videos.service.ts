import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { ChannelsService } from '../channels/channels.service';
import {
  PayloadTooLargeException,
  StorageUnavailableException,
  UploadIncompleteException,
  VideoForbiddenException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import {
  DEFAULT_PART_SIZE_BYTES,
  MAX_PART_COUNT,
  MAX_VIDEO_SIZE_BYTES,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_STATUS,
  buildVideoStorageKey,
} from './videos.constants';
import { generatePublicId } from './public-id.util';
import { STORAGE_SERVICE } from './storage/storage.service';
import type { StorageService } from './storage/storage.service';
import { VideoProcessingOutboxService } from './queue/video-processing-outbox.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreatePartsDto } from './dto/create-parts.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import {
  VideoCompleteResponseDto,
  VideoPartsResponseDto,
  VideoPublicResponseDto,
  VideoUploadInitResponseDto,
} from './dto/video-response.dto';

const PG_UNIQUE_VIOLATION = '23505';

export const UPLOAD_ABORTED_ERROR_CODE = 'UPLOAD_ABORTED';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as unknown as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    @Inject(STORAGE_SERVICE)
    private readonly storage: StorageService,
    private readonly outbox: VideoProcessingOutboxService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
    @Inject(queueConfig.KEY)
    private readonly queueCfg: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * Pre-registers the video as a `draft` and opens the multipart upload.
   *
   * The row is created *before* any bytes move, which is what gives the upload an
   * owner and a storage key from the very first request. The video id is minted
   * here rather than by the database because the storage key is derived from it
   * and must exist before the multipart upload is opened.
   */
  async initUpload(
    dto: CreateVideoUploadDto,
    userId: string,
  ): Promise<VideoUploadInitResponseDto> {
    if (dto.size_bytes > MAX_VIDEO_SIZE_BYTES) {
      throw new PayloadTooLargeException();
    }

    const channelId = await this.resolveChannelId(userId);
    const partSize = dto.part_size ?? DEFAULT_PART_SIZE_BYTES;
    const videoId = randomUUID();
    const storageKey = buildVideoStorageKey(videoId);

    const { uploadId } = await this.storage.createMultipartUpload(
      storageKey,
      dto.mime_type,
    );

    try {
      const video = await this.dataSource.transaction((manager) =>
        this.insertDraftWithUniquePublicId(manager, {
          id: videoId,
          channelId,
          title: dto.title,
          storageKey,
          uploadId,
          sizeBytes: dto.size_bytes,
          mimeType: dto.mime_type,
        }),
      );

      return {
        id: video.id,
        public_id: video.public_id,
        title: video.title,
        status: video.status,
        upload_id: uploadId,
        part_size: partSize,
        part_count: Math.min(
          Math.ceil(dto.size_bytes / partSize),
          MAX_PART_COUNT,
        ),
        created_at: video.created_at.toISOString(),
      };
    } catch (error) {
      // The multipart upload is already open in storage; leaving it behind would
      // leak parts until the cleanup sweep, so it is aborted before rethrowing.
      await this.abortQuietly(storageKey, uploadId);
      throw error;
    }
  }

  /** Presigns the parts the client is about to upload. */
  async createPartUrls(
    id: string,
    dto: CreatePartsDto,
    userId: string,
  ): Promise<VideoPartsResponseDto> {
    const video = await this.findOwnedVideo(id, userId);
    const uploadId = this.requireUploadId(video);

    const parts = await Promise.all(
      dto.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.createPartUploadUrl(
          video.storage_key,
          uploadId,
          partNumber,
        ),
        expires_in: this.storageCfg.presignExpiresIn,
      })),
    );

    return { parts };
  }

  /**
   * Finalises the upload.
   *
   * Storage assembles the object first, then `HeadObject` reports its **real**
   * size — the client's declared size is never trusted for the limit. Only after
   * that does one transaction move the video to `processing` and record the
   * outbox event, so the status change and the intent to enqueue commit together.
   */
  async completeUpload(
    id: string,
    dto: CompleteUploadDto,
    userId: string,
  ): Promise<VideoCompleteResponseDto> {
    const video = await this.findOwnedVideo(id, userId);
    const uploadId = this.requireUploadId(video);

    await this.storage.completeMultipartUpload(
      video.storage_key,
      uploadId,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    const head = await this.headObjectOrIncomplete(video.storage_key);

    if (head.size > MAX_VIDEO_SIZE_BYTES) {
      // An oversized object must not linger: it already cost bandwidth and disk.
      await this.storage.deleteObject(video.storage_key);
      throw new PayloadTooLargeException();
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        Video,
        { id: video.id, status: VIDEO_STATUS.DRAFT },
        {
          status: VIDEO_STATUS.PROCESSING,
          size_bytes: head.size,
          upload_id: null,
        },
      );

      // Zero rows means another request already completed (or aborted) this
      // upload. The guard is what makes a repeated complete a 409 rather than a
      // second processing run.
      if (result.affected === 0) {
        throw new VideoNotDraftException();
      }

      const processing = await manager.findOneByOrFail(Video, { id: video.id });
      await this.outbox.enqueueInTransaction(manager, processing);

      return {
        id: processing.id,
        public_id: processing.public_id,
        status: processing.status,
      };
    });
  }

  /**
   * Abandons an in-flight upload. The row is kept and marked `error` so the
   * attempt stays auditable rather than vanishing.
   */
  async abortUpload(id: string, userId: string): Promise<void> {
    const video = await this.findOwnedVideo(id, userId);
    const uploadId = this.requireUploadId(video);

    await this.storage.abortMultipartUpload(video.storage_key, uploadId);

    await this.videoRepository.update(
      { id: video.id, status: VIDEO_STATUS.DRAFT },
      {
        status: VIDEO_STATUS.ERROR,
        error_code: UPLOAD_ABORTED_ERROR_CODE,
        upload_id: null,
      },
    );
  }

  /** Public view of a video — never exposes the internal id or the storage key. */
  async getPublicMetadata(publicId: string): Promise<VideoPublicResponseDto> {
    const video = await this.findByPublicId(publicId);

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: video.thumbnail_key
        ? `/videos/${video.public_id}/thumbnail`
        : null,
      created_at: video.created_at.toISOString(),
    };
  }

  /**
   * Presigned playback URL. The client follows the redirect and issues `Range`
   * requests straight against storage, so the API never carries video bytes and
   * `206`/`416` come from the storage's own range implementation.
   */
  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storage.getPresignedReadUrl(video.storage_key);
  }

  /** Download URL, signed as an attachment so the browser saves rather than plays. */
  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);

    return this.storage.getPresignedReadUrl(video.storage_key, {
      downloadName: `${video.title}.mp4`,
    });
  }

  async getThumbnailUrl(publicId: string): Promise<string> {
    const video = await this.findByPublicId(publicId);

    if (!video.thumbnail_key) {
      // Still processing, or processing ended without a thumbnail.
      throw new VideoNotFoundException();
    }

    return this.storage.getPresignedReadUrl(video.thumbnail_key);
  }

  /** Issues a fresh presign for a player whose previous URL expired. */
  async getPlaybackUrl(
    publicId: string,
  ): Promise<{ url: string; expires_in: number }> {
    const url = await this.getStreamUrl(publicId);

    return { url, expires_in: this.storageCfg.presignExpiresIn };
  }

  private async findByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  private async findReadyByPublicId(publicId: string): Promise<Video> {
    const video = await this.findByPublicId(publicId);

    if (video.status !== VIDEO_STATUS.READY) {
      throw new VideoNotReadyException();
    }

    return video;
  }

  private async insertDraftWithUniquePublicId(
    manager: EntityManager,
    draft: {
      id: string;
      channelId: string;
      title: string;
      storageKey: string;
      uploadId: string;
      sizeBytes: number;
      mimeType: string;
    },
  ): Promise<Video> {
    for (let attempt = 0; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      // A unique violation aborts the whole transaction in PostgreSQL, so each
      // attempt is wrapped in a savepoint that can be rolled back on its own.
      await manager.query(`SAVEPOINT public_id_attempt_${attempt}`);

      try {
        const saved = await manager.save(
          manager.create(Video, {
            id: draft.id,
            public_id: generatePublicId(),
            channel_id: draft.channelId,
            title: draft.title,
            status: VIDEO_STATUS.DRAFT,
            storage_key: draft.storageKey,
            upload_id: draft.uploadId,
            size_bytes: draft.sizeBytes,
            mime_type: draft.mimeType,
          }),
        );
        await manager.query(`RELEASE SAVEPOINT public_id_attempt_${attempt}`);
        return saved;
      } catch (error) {
        await manager.query(
          `ROLLBACK TO SAVEPOINT public_id_attempt_${attempt}`,
        );

        if (!isUniqueViolation(error) || attempt === PUBLIC_ID_MAX_ATTEMPTS) {
          throw error;
        }
        this.logger.warn(
          `public_id collision on attempt ${attempt + 1}; regenerating`,
        );
      }
    }

    throw new Error('public_id collision could not be resolved');
  }

  /** Every mutating operation acts as the caller's channel — never a body field. */
  private async resolveChannelId(userId: string): Promise<string> {
    const channel = await this.channelsService.findByUserId(userId);

    if (!channel) {
      // Registration always creates a channel, so a user without one cannot act
      // on videos at all.
      throw new VideoForbiddenException();
    }

    return channel.id;
  }

  private async findOwnedVideo(id: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id });

    if (!video) {
      throw new VideoNotFoundException();
    }

    const channelId = await this.resolveChannelId(userId);
    if (video.channel_id !== channelId) {
      throw new VideoForbiddenException();
    }

    return video;
  }

  private requireUploadId(video: Video): string {
    if (video.status !== VIDEO_STATUS.DRAFT || video.upload_id === null) {
      throw new VideoNotDraftException();
    }

    return video.upload_id;
  }

  private async headObjectOrIncomplete(
    key: string,
  ): Promise<{ size: number; contentType: string | null }> {
    try {
      return await this.storage.headObject(key);
    } catch (error) {
      // Storage being unreachable is a transport problem and must stay a 503;
      // anything else means the object the client claims to have uploaded is not
      // actually there.
      if (error instanceof StorageUnavailableException) {
        throw error;
      }
      throw new UploadIncompleteException();
    }
  }

  private async abortQuietly(key: string, uploadId: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadId);
    } catch (error) {
      // The original failure is what the caller needs to see; a failed
      // compensation is recorded and left to the cleanup sweep.
      this.logger.error(
        `Failed to abort multipart upload ${uploadId} for ${key}`,
        error as Error,
      );
    }
  }
}
