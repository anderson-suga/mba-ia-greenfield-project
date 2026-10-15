import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { VideoProcessingJob } from '../queue/video-processing.types';
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
import { VideoProcessingOutboxService } from '../queue/video-processing-outbox.service';
import { S3StorageService } from '../storage/s3-storage.service';
import { STORAGE_SERVICE } from '../storage/storage.service';
import { buildThumbnailStorageKey, VIDEO_STATUS } from '../videos.constants';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import {
  createCorruptFile,
  createSampleVideo,
  describeWithFfmpeg,
} from './test-media.util';

const ALL_ENTITIES = [User, Channel, Video, VideoProcessingOutbox];

describeWithFfmpeg('VideoProcessingProcessor (integration, real stack)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessingProcessor;
  let storage: S3StorageService;
  let videoRepository: Repository<Video>;
  let outboxRepository: Repository<VideoProcessingOutbox>;
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
        VideoProcessingProcessor,
        MediaProbeService,
        ThumbnailService,
        VideoProcessingOutboxService,
        { provide: STORAGE_SERVICE, useClass: S3StorageService },
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    processor = moduleRef.get(VideoProcessingProcessor);
    storage = moduleRef.get<S3StorageService>(STORAGE_SERVICE);
    videoRepository = dataSource.getRepository(Video);
    outboxRepository = dataSource.getRepository(VideoProcessingOutbox);

    const user = await dataSource.getRepository(User).save({
      email: `processor_${Date.now()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Processor',
      nickname: `processor_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  const createdKeys: string[] = [];

  async function seedProcessingVideo(payload: Buffer): Promise<{
    video: Video;
    eventId: string;
    job: Job<VideoProcessingJob>;
  }> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `pr${randomUUID().slice(0, 8)}`.slice(0, 11),
        channel_id: channelId,
        title: 'Processing video',
        status: VIDEO_STATUS.PROCESSING,
        storage_key: `videos/${randomUUID()}/source.mp4`,
        mime_type: 'video/mp4',
        size_bytes: payload.length,
      }),
    );
    createdKeys.push(video.storage_key);
    await storage.putObject(video.storage_key, payload, 'video/mp4');

    const eventId = randomUUID();
    await outboxRepository.save(
      outboxRepository.create({
        event_id: eventId,
        video_id: video.id,
        status: 'pending',
        attempts: 0,
        payload: {
          video_id: video.id,
          storage_key: video.storage_key,
        },
      }),
    );

    const job = {
      id: eventId,
      name: 'video.process',
      data: {
        video_id: video.id,
        storage_key: video.storage_key,
        event_id: eventId,
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job<VideoProcessingJob>;

    return { video, eventId, job };
  }

  it('should take a video from processing to ready with a stored thumbnail', async () => {
    const { video, job } = await seedProcessingVideo(
      await createSampleVideo(2),
    );

    await processor.process(job);

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VIDEO_STATUS.READY);
    expect(updated.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(updated.thumbnail_key).toBe(buildThumbnailStorageKey(video.id));

    // The thumbnail really is in storage, which is what `ready` promises.
    const thumbnailKey = buildThumbnailStorageKey(video.id);
    createdKeys.push(thumbnailKey);
    const head = await storage.headObject(thumbnailKey);
    expect(head.size).toBeGreaterThan(0);
    expect(head.contentType).toBe('image/jpeg');

    const metadata = updated.metadata as {
      video?: { codec?: string };
      audio?: { codec?: string };
    };
    expect(metadata.video?.codec).toBe('h264');
    expect(metadata.audio?.codec).toBe('aac');
  });

  it('should mark the outbox event processed', async () => {
    const { video, eventId, job } = await seedProcessingVideo(
      await createSampleVideo(1),
    );

    await processor.process(job);

    const outbox = await outboxRepository.findOneByOrFail({
      event_id: eventId,
    });
    expect(outbox.status).toBe('processed');
    expect(outbox.processed_at).toBeInstanceOf(Date);
    createdKeys.push(buildThumbnailStorageKey(video.id));
  });

  it('should be a no-op when the same job runs again', async () => {
    const { video, job } = await seedProcessingVideo(
      await createSampleVideo(1),
    );

    await processor.process(job);
    const firstReady = await videoRepository.findOneByOrFail({
      id: video.id,
    });

    await expect(processor.process(job)).resolves.toBeUndefined();

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.updated_at.getTime()).toBe(firstReady.updated_at.getTime());
    createdKeys.push(buildThumbnailStorageKey(video.id));
  });

  it('should mark an undecodable upload as INVALID_MEDIA without a retry', async () => {
    const { video, eventId, job } =
      await seedProcessingVideo(createCorruptFile());

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VIDEO_STATUS.ERROR);
    expect(updated.error_code).toBe('INVALID_MEDIA');
    expect(updated.error_message).toBeTruthy();
    // `ready` is never written without a thumbnail.
    expect(updated.thumbnail_key).toBeNull();

    const outbox = await outboxRepository.findOneByOrFail({
      event_id: eventId,
    });
    expect(outbox.status).toBe('failed');
  });
});
