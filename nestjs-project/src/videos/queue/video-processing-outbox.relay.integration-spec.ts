import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { createTestDataSource } from '../../test/create-test-data-source';
import { Video } from '../entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoProcessingOutboxRelay } from './video-processing-outbox.relay';
import { VideoProcessingOutboxService } from './video-processing-outbox.service';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.queue';
import { OUTBOX_STATUS } from './video-processing.types';

const ALL_ENTITIES = [User, Channel, Video, VideoProcessingOutbox];

/**
 * Exercises the outbox against the real PostgreSQL and Redis from Compose. The
 * relay is driven explicitly through `processPending()` — the poll timer is
 * disabled under test — so dispatch is deterministic and no suite sleeps.
 */
describe('VideoProcessingOutboxRelay (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let relay: VideoProcessingOutboxRelay;
  let outboxService: VideoProcessingOutboxService;
  let queue: Queue;
  let videoRepository: Repository<Video>;
  let outboxRepository: Repository<VideoProcessingOutbox>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES).options,
          autoLoadEntities: true,
        }),
        TypeOrmModule.forFeature([Video, VideoProcessingOutbox]),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingOutboxService, VideoProcessingOutboxRelay],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    relay = moduleRef.get(VideoProcessingOutboxRelay);
    outboxService = moduleRef.get(VideoProcessingOutboxService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videoRepository = dataSource.getRepository(Video);
    outboxRepository = dataSource.getRepository(VideoProcessingOutbox);

    // The queue is shared with the dev stack; start from a clean slate.
    await queue.drain(true);
  });

  beforeEach(async () => {
    // Every test asserts on exactly what it enqueued, so leftover pending rows
    // from an earlier test must not be claimable.
    await dataSource.query('DELETE FROM "video_processing_outbox"');
    await queue.drain(true);
  });

  afterAll(async () => {
    await queue.drain(true);
    await dataSource.query('DELETE FROM "video_processing_outbox"');
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');
    // Closing the module tears down the BullMQ Redis connection and the data
    // source; without it Jest keeps the process alive on the open socket.
    await moduleRef.close();
  });

  let counter = 0;
  async function createVideo(): Promise<Video> {
    const n = ++counter;
    const db = dataSource;
    const user = await db.getRepository(User).save({
      email: `outbox_${n}_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    const channel = await db.getRepository(Channel).save({
      name: `Outbox ${n}`,
      nickname: `outbox_${n}_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });

    return videoRepository.save(
      videoRepository.create({
        public_id: `ob${n}${randomUUID().slice(0, 8)}`.slice(0, 11),
        channel_id: channel.id,
        title: `Outbox video ${n}`,
        status: 'processing',
        storage_key: `videos/${randomUUID()}/source.mp4`,
      }),
    );
  }

  async function enqueue(video: Video): Promise<VideoProcessingOutbox> {
    return dataSource.transaction((manager) =>
      outboxService.enqueueInTransaction(manager, video),
    );
  }

  it('should commit the outbox row inside the caller transaction', async () => {
    const video = await createVideo();

    const row = await enqueue(video);

    const persisted = await outboxRepository.findOneBy({ id: row.id });
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe(OUTBOX_STATUS.PENDING);
  });

  it('should discard the outbox row when the transaction rolls back', async () => {
    const video = await createVideo();
    const eventId = randomUUID();

    await expect(
      dataSource.transaction(async (manager) => {
        await manager.insert(VideoProcessingOutbox, {
          event_id: eventId,
          video_id: video.id,
          status: OUTBOX_STATUS.PENDING,
          attempts: 0,
          payload: { video_id: video.id, storage_key: video.storage_key },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await outboxService.findByEventId(eventId)).toBeNull();
  });

  it('should publish a real job to Redis and mark the row dispatched', async () => {
    const video = await createVideo();
    const row = await enqueue(video);

    const dispatched = await relay.processPending();

    expect(dispatched).toBe(1);

    const job = await queue.getJob(row.event_id);
    expect(job).not.toBeUndefined();
    expect(job?.name).toBe('video.process');
    expect(job?.data).toEqual({
      video_id: video.id,
      storage_key: video.storage_key,
    });

    const persisted = await outboxRepository.findOneByOrFail({ id: row.id });
    expect(persisted.status).toBe(OUTBOX_STATUS.DISPATCHED);
    expect(persisted.dispatched_at).toBeInstanceOf(Date);
  });

  it('should be a no-op on a second pass over already dispatched rows', async () => {
    const video = await createVideo();
    await enqueue(video);

    expect(await relay.processPending()).toBe(1);
    expect(await relay.processPending()).toBe(0);
  });

  it('should not create a second job for an event that was re-published', async () => {
    const video = await createVideo();
    const row = await enqueue(video);

    await relay.processPending();

    // Simulate a relay that crashed after publishing but before marking the row:
    // the row goes back to pending while the job already exists in Redis.
    await outboxRepository.update(
      { id: row.id },
      { status: OUTBOX_STATUS.PENDING, dispatched_at: null },
    );

    await relay.processPending();

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const matching = jobs.filter((job) => job.id === row.event_id);
    // jobId dedup: the second publish is ignored rather than creating a twin.
    expect(matching).toHaveLength(1);
  });

  it('should reclaim a row whose lease expired after a relay died mid-tick', async () => {
    const video = await createVideo();
    const row = await enqueue(video);

    // A stale lease, as if another relay claimed the row and never finished.
    await outboxRepository.update(
      { id: row.id },
      { claimed_at: new Date(Date.now() - 10 * 60 * 1000) },
    );

    expect(await relay.processPending()).toBe(1);
  });

  it('should skip a row that is still under an active lease', async () => {
    const video = await createVideo();
    const row = await enqueue(video);

    await outboxRepository.update({ id: row.id }, { claimed_at: new Date() });

    // Another relay holds the lease, so this one must not touch the row.
    expect(await relay.processPending()).toBe(0);
  });

  it('should leave rows untouched when the queue is unreachable', async () => {
    const video = await createVideo();
    const row = await enqueue(video);

    const brokenQueue = { add: jest.fn().mockRejectedValue(new Error('down')) };
    const isolatedRelay = new VideoProcessingOutboxRelay(
      dataSource,
      brokenQueue as unknown as Queue,
      {
        relayIntervalMs: 3000,
        relayClaimLeaseMs: 60000,
        relayBatchSize: 25,
        attempts: 3,
        backoffMs: 30000,
        redisHost: 'redis',
        redisPort: 6379,
        lockDurationMs: 1800000,
        stalledIntervalMs: 60000,
        maxStalledCount: 1,
      } as ConfigType<typeof queueConfig>,
    );

    const dispatched = await isolatedRelay.processPending();

    expect(dispatched).toBe(0);
    const persisted = await outboxRepository.findOneByOrFail({ id: row.id });
    // Nothing is lost: the row stays pending and the next tick retries it.
    expect(persisted.status).toBe(OUTBOX_STATUS.PENDING);
    expect(persisted.attempts).toBe(1);
    expect(persisted.error_message).toBe('down');

    // And the healthy relay picks it up straight away.
    expect(await relay.processPending()).toBe(1);
  });

  it('should mark the event processed and failed through the outbox service', async () => {
    const video = await createVideo();
    const row = await enqueue(video);

    await outboxService.markProcessed(row.event_id);
    const processed = await outboxRepository.findOneByOrFail({ id: row.id });
    expect(processed.status).toBe(OUTBOX_STATUS.PROCESSED);
    expect(processed.processed_at).toBeInstanceOf(Date);

    await outboxService.markProcessedFailed(row.event_id, 'boom');
    const failed = await outboxRepository.findOneByOrFail({ id: row.id });
    expect(failed.status).toBe(OUTBOX_STATUS.FAILED);
    expect(failed.error_message).toBe('boom');
  });
});
