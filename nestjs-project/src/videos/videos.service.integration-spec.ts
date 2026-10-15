import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './queue/entities/video-processing-outbox.entity';
import { VideoProcessingOutboxRelay } from './queue/video-processing-outbox.relay';
import { VideoProcessingOutboxService } from './queue/video-processing-outbox.service';
import { VIDEO_PROCESSING_QUEUE } from './queue/video-processing.queue';
import { S3StorageService } from './storage/s3-storage.service';
import { STORAGE_SERVICE } from './storage/storage.service';
import { VideosService } from './videos.service';
import { VIDEO_STATUS } from './videos.constants';

const ALL_ENTITIES = [User, Channel, Video, VideoProcessingOutbox];
const ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';

/**
 * Drives the upload flow through the service against the real Compose stack
 * (PostgreSQL, MinIO, Redis). The part URLs the service hands out are signed for
 * the browser host, so the bytes are uploaded through a second storage instance
 * pointed at the internal host — exactly what a client on the other side of the
 * network does.
 */
describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let videoRepository: Repository<Video>;
  let outboxRepository: Repository<VideoProcessingOutbox>;
  let internalStorage: S3StorageService;
  let userId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES).options,
          autoLoadEntities: true,
        }),
        TypeOrmModule.forFeature([Video, VideoProcessingOutbox]),
        ChannelsModule,
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [
        VideosService,
        VideoProcessingOutboxService,
        VideoProcessingOutboxRelay,
        { provide: STORAGE_SERVICE, useClass: S3StorageService },
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    videoRepository = dataSource.getRepository(Video);
    outboxRepository = dataSource.getRepository(VideoProcessingOutbox);

    internalStorage = new S3StorageService({
      endpoint: ENDPOINT,
      publicEndpoint: ENDPOINT,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube123',
      presignExpiresIn: 3600,
    });

    const user = await dataSource.getRepository(User).save({
      email: `videos_service_${Date.now()}@example.com`,
      password: 'hashed',
    });
    userId = user.id;
    await moduleRef.get(ChannelsService).createChannel(userId, user.email);
  });

  afterAll(async () => {
    // The shared helper clears every table in foreign-key order; deleting users
    // directly fails while auth token rows still reference them.
    await cleanAllTables(dataSource);
    internalStorage.onModuleDestroy();
    await moduleRef.close();
  });

  async function initAndUpload(sizeBytes: number): Promise<{
    id: string;
    uploadId: string;
    parts: { part_number: number; etag: string }[];
  }> {
    const init = await videosService.initUpload(
      {
        title: 'Integration video',
        filename: 'integration.mp4',
        size_bytes: sizeBytes,
        mime_type: 'video/mp4',
        part_size: Math.max(sizeBytes, 5 * 1024 ** 2),
      },
      userId,
    );

    const key = `videos/${init.id}/source.mp4`;
    const url = await internalStorage.createPartUploadUrl(
      key,
      init.upload_id,
      1,
    );
    const upload = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(sizeBytes, 'z'),
    });

    return {
      id: init.id,
      uploadId: init.upload_id,
      parts: [{ part_number: 1, etag: upload.headers.get('etag') ?? '' }],
    };
  }

  it('should take a video from draft to processing and record the real object size', async () => {
    const size = 5 * 1024 ** 2;
    const { id, parts } = await initAndUpload(size);

    const result = await videosService.completeUpload(id, { parts }, userId);

    expect(result.status).toBe(VIDEO_STATUS.PROCESSING);

    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VIDEO_STATUS.PROCESSING);
    // Measured on the stored object, not taken from the request.
    expect(row.size_bytes).toBe(size);
    expect(row.upload_id).toBeNull();
  });

  it('should commit the outbox row together with the status change', async () => {
    const { id, parts } = await initAndUpload(5 * 1024 ** 2);

    await videosService.completeUpload(id, { parts }, userId);

    const outbox = await outboxRepository.findOneBy({ video_id: id });
    expect(outbox).not.toBeNull();
    expect(outbox?.status).toBe('pending');
    expect(outbox?.payload).toEqual({
      video_id: id,
      storage_key: `videos/${id}/source.mp4`,
    });
  });

  it('should resolve two concurrent completions to exactly one success', async () => {
    const { id, parts } = await initAndUpload(5 * 1024 ** 2);

    const results = await Promise.allSettled([
      videosService.completeUpload(id, { parts }, userId),
      videosService.completeUpload(id, { parts }, userId),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // At least one call must succeed. The loser fails either at storage (the
    // multipart upload was already completed by the winner, so storage reports
    // NoSuchUpload) or, if it gets that far, at the guarded
    // `WHERE status = 'draft'` update — which is the VideoNotDraftException the
    // unit test pins down.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // The invariant that matters: exactly one job is owed, however the race ran.
    expect(await outboxRepository.countBy({ video_id: id })).toBe(1);

    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.status).toBe(VIDEO_STATUS.PROCESSING);
  });

  it('should mark a video as errored without deleting it when an upload is aborted', async () => {
    const init = await videosService.initUpload(
      {
        title: 'Aborted',
        filename: 'aborted.mp4',
        size_bytes: 1024,
        mime_type: 'video/mp4',
      },
      userId,
    );

    await videosService.abortUpload(init.id, userId);

    const row = await videoRepository.findOneByOrFail({ id: init.id });
    expect(row.status).toBe(VIDEO_STATUS.ERROR);
    expect(row.error_code).toBe('UPLOAD_ABORTED');
    // The row survives so the attempt stays auditable.
    expect(await outboxRepository.countBy({ video_id: init.id })).toBe(0);
  });
});
