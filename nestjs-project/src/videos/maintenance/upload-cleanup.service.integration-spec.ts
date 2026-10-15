import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from '../entities/video.entity';
import { VideoProcessingOutbox } from '../queue/entities/video-processing-outbox.entity';
import { S3StorageService } from '../storage/s3-storage.service';
import { STORAGE_SERVICE } from '../storage/storage.service';
import { VIDEO_STATUS } from '../videos.constants';
import {
  UPLOAD_EXPIRED_ERROR_CODE,
  UploadCleanupService,
} from './upload-cleanup.service';

const ALL_ENTITIES = [User, Channel, Video, VideoProcessingOutbox];

/**
 * Exercises the sweep against the real PostgreSQL and MinIO from Compose.
 *
 * The unit suite pins the decision logic; what this adds is the part that only
 * real infrastructure can answer — that the multipart upload is genuinely gone
 * from storage afterwards, not merely marked as such locally.
 */
describe('UploadCleanupService (integration, real MinIO + PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let cleanup: UploadCleanupService;
  let storage: S3StorageService;
  /**
   * Part URLs are signed for the browser host, which this process cannot reach.
   * This signs for the internal host so the setup can upload a real part — the
   * cleanup service under test only ever uses the internal client for its abort.
   */
  let internalSigner: S3StorageService;
  let videoRepository: Repository<Video>;
  let channelId: string;

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
      ],
      providers: [
        UploadCleanupService,
        { provide: STORAGE_SERVICE, useClass: S3StorageService },
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    cleanup = moduleRef.get(UploadCleanupService);
    storage = moduleRef.get<S3StorageService>(STORAGE_SERVICE);
    internalSigner = new S3StorageService({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
      publicEndpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube123',
      presignExpiresIn: 3600,
    });
    videoRepository = dataSource.getRepository(Video);

    const user = await dataSource.getRepository(User).save({
      email: `cleanup_${Date.now()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Cleanup',
      nickname: `cleanup_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    internalSigner.onModuleDestroy();
    await moduleRef.close();
  });

  /**
   * Creates a draft with a multipart upload genuinely open in storage, then ages
   * it. `updated_at` is written with raw SQL because the `@UpdateDateColumn`
   * decorator would stamp it with "now" on any repository write.
   */
  async function openAbandonedUpload(
    ageHours: number,
  ): Promise<{ video: Video; uploadId: string; partEtag: string }> {
    const storageKey = `videos/${randomUUID()}/source.mp4`;
    const { uploadId } = await storage.createMultipartUpload(
      storageKey,
      'video/mp4',
    );

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `cl${randomUUID().slice(0, 8)}`.slice(0, 11),
        channel_id: channelId,
        title: 'Abandoned upload',
        status: VIDEO_STATUS.DRAFT,
        storage_key: storageKey,
        upload_id: uploadId,
        mime_type: 'video/mp4',
      }),
    );

    // A part really uploaded, so the abandoned upload has something to discard.
    const url = await internalSigner.createPartUploadUrl(
      storageKey,
      uploadId,
      1,
    );
    const upload = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(5 * 1024 ** 2, 'p'),
    });

    await dataSource.query(
      `UPDATE "videos" SET "updated_at" = now() - ($2 || ' hours')::interval WHERE "id" = $1`,
      [video.id, String(ageHours)],
    );

    return {
      video: await videoRepository.findOneByOrFail({ id: video.id }),
      uploadId,
      partEtag: upload.headers.get('etag') ?? '',
    };
  }

  it('should expire an abandoned draft and record why', async () => {
    const { video } = await openAbandonedUpload(48);

    const expired = await cleanup.cleanupAbandonedUploads();

    expect(expired).toBeGreaterThanOrEqual(1);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VIDEO_STATUS.ERROR);
    expect(row.error_code).toBe(UPLOAD_EXPIRED_ERROR_CODE);
    // The reference to a dead upload is cleared.
    expect(row.upload_id).toBeNull();
    // The row survives, so the attempt stays auditable.
    expect(row.storage_key).toBe(video.storage_key);
  });

  it('should really abort the multipart upload in storage', async () => {
    const { video, uploadId, partEtag } = await openAbandonedUpload(48);

    await cleanup.cleanupAbandonedUploads();

    // The decisive check: storage no longer knows this upload, so completing it
    // is refused. Aborting only in the database would leave the parts behind.
    await expect(
      storage.completeMultipartUpload(video.storage_key, uploadId, [
        { partNumber: 1, etag: partEtag },
      ]),
    ).rejects.toThrow();
  });

  it('should leave a draft that is still within the retention window alone', async () => {
    const { video } = await openAbandonedUpload(1);

    await cleanup.cleanupAbandonedUploads();

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VIDEO_STATUS.DRAFT);
    expect(row.upload_id).not.toBeNull();
  });

  it('should expire the row even when storage has already dropped the upload', async () => {
    const { video, uploadId } = await openAbandonedUpload(48);

    // Simulate MinIO having purged the incomplete upload on its own.
    await storage.abortMultipartUpload(video.storage_key, uploadId);

    await cleanup.cleanupAbandonedUploads();

    // A storage error must not stop the database from reaching a terminal state.
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VIDEO_STATUS.ERROR);
    expect(row.error_code).toBe(UPLOAD_EXPIRED_ERROR_CODE);
  });

  it('should ignore drafts that never opened an upload', async () => {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `nd${randomUUID().slice(0, 8)}`.slice(0, 11),
        channel_id: channelId,
        title: 'No upload opened',
        status: VIDEO_STATUS.DRAFT,
        storage_key: `videos/${randomUUID()}/source.mp4`,
      }),
    );
    await dataSource.query(
      `UPDATE "videos" SET "updated_at" = now() - interval '48 hours' WHERE "id" = $1`,
      [video.id],
    );

    await cleanup.cleanupAbandonedUploads();

    // Nothing to abort, and no upload_id to key a decision on.
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VIDEO_STATUS.DRAFT);
  });
});
