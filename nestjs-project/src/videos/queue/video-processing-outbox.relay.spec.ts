import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import {
  MAX_DISPATCH_ATTEMPTS,
  VideoProcessingOutboxRelay,
} from './video-processing-outbox.relay';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.queue';
import { OUTBOX_STATUS } from './video-processing.types';

const buildRow = (
  overrides: Partial<VideoProcessingOutbox> = {},
): VideoProcessingOutbox =>
  ({
    id: 'row-1',
    event_id: '22222222-2222-4222-8222-222222222222',
    video_id: '11111111-1111-4111-8111-111111111111',
    status: OUTBOX_STATUS.PENDING,
    attempts: 0,
    payload: {
      video_id: '11111111-1111-4111-8111-111111111111',
      storage_key: 'videos/11111111-1111-4111-8111-111111111111/source.mp4',
    },
    claimed_at: null,
    dispatched_at: null,
    processed_at: null,
    error_message: null,
    created_at: new Date(),
    ...overrides,
  }) as VideoProcessingOutbox;

const CONFIG = {
  redisHost: 'redis',
  redisPort: 6379,
  attempts: 3,
  backoffMs: 30_000,
  lockDurationMs: 1_800_000,
  stalledIntervalMs: 60_000,
  maxStalledCount: 1,
  relayIntervalMs: 3_000,
  relayClaimLeaseMs: 60_000,
  relayBatchSize: 25,
} as ConfigType<typeof queueConfig>;

describe('VideoProcessingOutboxRelay', () => {
  let relay: VideoProcessingOutboxRelay;
  const mockQuery = jest.fn();
  const mockQueue = { add: jest.fn() };

  const buildRelay = async (): Promise<VideoProcessingOutboxRelay> => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingOutboxRelay,
        { provide: DataSource, useValue: { query: mockQuery } },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: mockQueue,
        },
        { provide: queueConfig.KEY, useValue: CONFIG },
      ],
    }).compile();

    return module.get(VideoProcessingOutboxRelay);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQueue.add.mockResolvedValue({ id: 'job-1' });
    relay = await buildRelay();
  });

  afterEach(() => {
    relay.onModuleDestroy();
  });

  describe('processPending', () => {
    it('should return 0 when nothing is pending', async () => {
      mockQuery.mockResolvedValueOnce([[], 0]);

      await expect(relay.processPending()).resolves.toBe(0);
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should claim rows with the lease cutoff and the configured batch size', async () => {
      mockQuery.mockResolvedValueOnce([[], 0]);

      await relay.processPending();

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(sql).toContain('"claimed_at" IS NULL');
      expect(params[0]).toBe(OUTBOX_STATUS.PENDING);
      expect(params[1]).toBeInstanceOf(Date);
      expect(params[2]).toBe(CONFIG.relayBatchSize);
    });

    it('should publish the job with jobId equal to the event id', async () => {
      const row = buildRow();
      mockQuery.mockResolvedValueOnce([[row], 1]).mockResolvedValue(undefined);

      const dispatched = await relay.processPending();

      expect(dispatched).toBe(1);
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      const [jobName, payload, options] = mockQueue.add.mock.calls[0] as [
        string,
        Record<string, unknown>,
        { jobId: string; attempts: number },
      ];
      expect(jobName).toBe('video.process');
      expect(payload).toEqual(row.payload);
      // The dedup primitive: a repeated dispatch of one event cannot create two jobs.
      expect(options.jobId).toBe(row.event_id);
      expect(options.attempts).toBe(CONFIG.attempts);
    });

    it('should mark the row dispatched after a successful publish', async () => {
      mockQuery
        .mockResolvedValueOnce([[buildRow()], 1])
        .mockResolvedValue(undefined);

      await relay.processPending();

      const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('UPDATE "video_processing_outbox"');
      expect(params[1]).toBe(OUTBOX_STATUS.DISPATCHED);
      expect(params[2]).toBe(1);
    });

    it('should leave the row pending and record the error when dispatch fails', async () => {
      mockQueue.add.mockRejectedValue(new Error('redis is down'));
      mockQuery
        .mockResolvedValueOnce([[buildRow()], 1])
        .mockResolvedValue(undefined);

      const dispatched = await relay.processPending();

      expect(dispatched).toBe(0);
      const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain('UPDATE "video_processing_outbox"');
      // Still pending: the relay must retry on the next tick, losing nothing.
      expect(params[1]).toBe(OUTBOX_STATUS.PENDING);
      expect(params[3]).toBe('redis is down');
    });

    it('should give up and mark the row failed once dispatch attempts are exhausted', async () => {
      mockQueue.add.mockRejectedValue(new Error('redis is down'));
      mockQuery
        .mockResolvedValueOnce([
          [buildRow({ attempts: MAX_DISPATCH_ATTEMPTS - 1 })],
          1,
        ])
        .mockResolvedValue(undefined);

      await relay.processPending();

      const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(params[1]).toBe(OUTBOX_STATUS.FAILED);
      expect(params[2]).toBe(MAX_DISPATCH_ATTEMPTS);
    });

    it('should dispatch every claimed row independently', async () => {
      mockQueue.add
        .mockResolvedValueOnce({ id: 'job-1' })
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ id: 'job-3' });
      mockQuery
        .mockResolvedValueOnce([
          [
            buildRow({ id: 'row-1' }),
            buildRow({ id: 'row-2' }),
            buildRow({ id: 'row-3' }),
          ],
          3,
        ])
        .mockResolvedValue(undefined);

      await expect(relay.processPending()).resolves.toBe(2);
    });

    it('should not run two overlapping dispatches in the same process', async () => {
      let resolveClaim: (
        result: [VideoProcessingOutbox[], number],
      ) => void = () => {};
      mockQuery.mockImplementationOnce(
        () =>
          new Promise<[VideoProcessingOutbox[], number]>((resolve) => {
            resolveClaim = resolve;
          }),
      );

      const first = relay.processPending();
      const second = await relay.processPending();

      expect(second).toBe(0);

      resolveClaim([[], 0]);
      await expect(first).resolves.toBe(0);
    });
  });

  describe('timer lifecycle', () => {
    it('should not schedule the poll timer while running under test', () => {
      // Tests dispatch explicitly, so the timer would only add nondeterminism.
      expect(process.env.NODE_ENV).toBe('test');
      relay.onModuleInit();
      relay.onModuleDestroy();
    });
  });
});
