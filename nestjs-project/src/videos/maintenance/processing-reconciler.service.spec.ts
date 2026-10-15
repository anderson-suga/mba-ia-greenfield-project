import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import type { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS } from '../videos.constants';
import { VideoProcessingOutbox } from '../queue/entities/video-processing-outbox.entity';
import { VideoProcessingOutboxService } from '../queue/video-processing-outbox.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import {
  MAX_RECONCILE_ATTEMPTS,
  PROCESSING_STALLED_ERROR_CODE,
  ProcessingReconcilerService,
} from './processing-reconciler.service';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

const CONFIG = {
  stalledProcessingMs: 7_200_000,
  maintenanceIntervalMs: 900_000,
} as ConfigType<typeof queueConfig>;

describe('ProcessingReconcilerService', () => {
  let service: ProcessingReconcilerService;

  const videoRepository = { find: jest.fn(), update: jest.fn() };
  const outboxRepository = { countBy: jest.fn(), findBy: jest.fn() };
  const outboxService = { enqueueInTransaction: jest.fn() };
  const queue = { getJob: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.update.mockResolvedValue({ affected: 1 });
    outboxRepository.findBy.mockResolvedValue([]);
    outboxService.enqueueInTransaction.mockResolvedValue({});

    const module = await Test.createTestingModule({
      providers: [
        ProcessingReconcilerService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository as unknown as Repository<Video>,
        },
        {
          provide: getRepositoryToken(VideoProcessingOutbox),
          useValue:
            outboxRepository as unknown as Repository<VideoProcessingOutbox>,
        },
        { provide: VideoProcessingOutboxService, useValue: outboxService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        { provide: queueConfig.KEY, useValue: CONFIG },
      ],
    }).compile();

    service = module.get(ProcessingReconcilerService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should only consider videos that have been processing past the threshold', async () => {
    videoRepository.find.mockResolvedValue([]);

    await service.reconcileStalledProcessing(new Date('2026-06-01T12:00:00Z'));

    const [args] = videoRepository.find.mock.calls[0] as [
      { where: { status: string; updated_at: unknown } },
    ];
    expect(args.where.status).toBe(VIDEO_STATUS.PROCESSING);
    const cutoff = (args.where.updated_at as { _value: Date })._value;
    // Two hours before `now`.
    expect(cutoff.toISOString()).toBe('2026-06-01T10:00:00.000Z');
  });

  it('should re-enqueue a stalled video that still has attempts left', async () => {
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID }]);
    outboxRepository.countBy.mockResolvedValue(1);

    const reconciled = await service.reconcileStalledProcessing();

    expect(reconciled).toBe(1);
    expect(outboxService.enqueueInTransaction).toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('should give up and mark the video stalled once attempts are exhausted', async () => {
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID }]);
    outboxRepository.countBy.mockResolvedValue(MAX_RECONCILE_ATTEMPTS);

    await service.reconcileStalledProcessing();

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VIDEO_STATUS.PROCESSING },
      expect.objectContaining({
        status: VIDEO_STATUS.ERROR,
        error_code: PROCESSING_STALLED_ERROR_CODE,
      }),
    );
    expect(outboxService.enqueueInTransaction).not.toHaveBeenCalled();
  });

  it('should leave a video alone while a job for it is still live', async () => {
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID }]);
    outboxRepository.countBy.mockResolvedValue(1);
    outboxRepository.findBy.mockResolvedValue([{ event_id: EVENT_ID }]);
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('active'),
    });

    const reconciled = await service.reconcileStalledProcessing();

    // The worker is simply taking its time; re-enqueueing would double-process it.
    expect(reconciled).toBe(0);
    expect(outboxService.enqueueInTransaction).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('should reconcile a video whose job has already finished', async () => {
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID }]);
    outboxRepository.countBy.mockResolvedValue(1);
    outboxRepository.findBy.mockResolvedValue([{ event_id: EVENT_ID }]);
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('completed'),
    });

    const reconciled = await service.reconcileStalledProcessing();

    // A finished job that never moved the row means the dispatch was lost.
    expect(reconciled).toBe(1);
    expect(outboxService.enqueueInTransaction).toHaveBeenCalled();
  });

  it('should reconcile a video with no job in the queue at all', async () => {
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID }]);
    outboxRepository.countBy.mockResolvedValue(1);
    outboxRepository.findBy.mockResolvedValue([{ event_id: EVENT_ID }]);
    queue.getJob.mockResolvedValue(undefined);

    await expect(service.reconcileStalledProcessing()).resolves.toBe(1);
  });
});
