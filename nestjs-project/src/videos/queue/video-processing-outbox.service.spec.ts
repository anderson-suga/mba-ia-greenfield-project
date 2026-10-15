import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoProcessingOutboxService } from './video-processing-outbox.service';
import { OUTBOX_STATUS } from './video-processing.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('VideoProcessingOutboxService', () => {
  let service: VideoProcessingOutboxService;
  const mockRepository = {
    update: jest.fn(),
    findOneBy: jest.fn(),
  };
  const mockManager = {
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockManager.create.mockImplementation(
      (_entity: unknown, data: unknown) => data,
    );
    mockManager.save.mockImplementation((data: unknown) =>
      Promise.resolve(data),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingOutboxService,
        {
          provide: getRepositoryToken(VideoProcessingOutbox),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get(VideoProcessingOutboxService);
  });

  describe('enqueueInTransaction', () => {
    const video = {
      id: '11111111-1111-4111-8111-111111111111',
      storage_key: 'videos/11111111-1111-4111-8111-111111111111/source.mp4',
    };

    it('should insert a pending row through the caller transaction manager', async () => {
      await service.enqueueInTransaction(
        mockManager as unknown as EntityManager,
        video as never,
      );

      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(mockRepository.update).not.toHaveBeenCalled();
    });

    it('should generate a distinct event id per enqueue', async () => {
      const first = await service.enqueueInTransaction(
        mockManager as unknown as EntityManager,
        video as never,
      );
      const second = await service.enqueueInTransaction(
        mockManager as unknown as EntityManager,
        video as never,
      );

      expect(first.event_id).toMatch(UUID_PATTERN);
      expect(second.event_id).toMatch(UUID_PATTERN);
      expect(first.event_id).not.toBe(second.event_id);
    });

    it('should store a pointer payload without the event id', async () => {
      const row = await service.enqueueInTransaction(
        mockManager as unknown as EntityManager,
        video as never,
      );

      expect(row.payload).toEqual({
        video_id: video.id,
        storage_key: video.storage_key,
      });
      expect(row.status).toBe(OUTBOX_STATUS.PENDING);
      expect(row.attempts).toBe(0);
    });

    it('should leave the dispatch bookkeeping columns unset', async () => {
      const row = await service.enqueueInTransaction(
        mockManager as unknown as EntityManager,
        video as never,
      );

      expect(row.claimed_at).toBeNull();
      expect(row.dispatched_at).toBeNull();
      expect(row.processed_at).toBeNull();
      expect(row.error_message).toBeNull();
    });
  });

  describe('markProcessed', () => {
    it('should record the terminal status and timestamp', async () => {
      await service.markProcessed('event-1');

      expect(mockRepository.update).toHaveBeenCalledWith(
        { event_id: 'event-1' },
        expect.objectContaining({ status: OUTBOX_STATUS.PROCESSED }),
      );
      const [, patch] = mockRepository.update.mock.calls[0] as [
        unknown,
        { processed_at: unknown },
      ];
      expect(patch.processed_at).toBeInstanceOf(Date);
    });
  });

  describe('markProcessedFailed', () => {
    it('should record the failure status and reason', async () => {
      await service.markProcessedFailed('event-1', 'ffprobe exploded');

      expect(mockRepository.update).toHaveBeenCalledWith(
        { event_id: 'event-1' },
        expect.objectContaining({
          status: OUTBOX_STATUS.FAILED,
          error_message: 'ffprobe exploded',
        }),
      );
    });
  });

  describe('findByEventId', () => {
    it('should look the row up by event id', async () => {
      mockRepository.findOneBy.mockResolvedValue(null);

      await service.findByEventId('event-1');

      expect(mockRepository.findOneBy).toHaveBeenCalledWith({
        event_id: 'event-1',
      });
    });
  });
});
