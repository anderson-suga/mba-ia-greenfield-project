import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import type { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS } from '../videos.constants';
import { STORAGE_SERVICE } from '../storage/storage.service';
import {
  UPLOAD_EXPIRED_ERROR_CODE,
  UploadCleanupService,
} from './upload-cleanup.service';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';

const CONFIG = {
  staleUploadHours: 24,
  maintenanceIntervalMs: 900_000,
} as ConfigType<typeof queueConfig>;

describe('UploadCleanupService', () => {
  let service: UploadCleanupService;

  const videoRepository = { find: jest.fn(), update: jest.fn() };
  const storage = { abortMultipartUpload: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.update.mockResolvedValue({ affected: 1 });
    storage.abortMultipartUpload.mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        UploadCleanupService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository as unknown as Repository<Video>,
        },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: queueConfig.KEY, useValue: CONFIG },
      ],
    }).compile();

    service = module.get(UploadCleanupService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should only look at drafts older than the retention window', async () => {
    videoRepository.find.mockResolvedValue([]);
    const now = new Date('2026-06-01T12:00:00.000Z');

    await service.cleanupAbandonedUploads(now);

    const [args] = videoRepository.find.mock.calls[0] as [
      { where: { status: string; updated_at: unknown } },
    ];
    expect(args.where.status).toBe(VIDEO_STATUS.DRAFT);
    // 24h before `now`, so an upload started minutes ago is left alone.
    const cutoff = (args.where.updated_at as { _value: Date })._value;
    expect(cutoff.toISOString()).toBe('2026-05-31T12:00:00.000Z');
  });

  it('should abort the abandoned multipart upload and expire the draft', async () => {
    videoRepository.find.mockResolvedValue([
      {
        id: VIDEO_ID,
        storage_key: 'videos/x/source.mp4',
        upload_id: 'up-1',
        updated_at: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);

    const expired = await service.cleanupAbandonedUploads();

    expect(expired).toBe(1);
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/x/source.mp4',
      'up-1',
    );
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VIDEO_STATUS.DRAFT },
      expect.objectContaining({
        status: VIDEO_STATUS.ERROR,
        error_code: UPLOAD_EXPIRED_ERROR_CODE,
      }),
    );
  });

  it('should still expire the row when storage has already dropped the upload', async () => {
    videoRepository.find.mockResolvedValue([
      {
        id: VIDEO_ID,
        storage_key: 'videos/x/source.mp4',
        upload_id: 'up-1',
        updated_at: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
    storage.abortMultipartUpload.mockRejectedValue(new Error('NoSuchUpload'));

    const expired = await service.cleanupAbandonedUploads();

    // The database state is what matters; a missing upload is not a failure.
    expect(expired).toBe(1);
    expect(videoRepository.update).toHaveBeenCalled();
  });

  it('should report nothing when there is nothing to clean', async () => {
    videoRepository.find.mockResolvedValue([]);

    await expect(service.cleanupAbandonedUploads()).resolves.toBe(0);
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should not count a row that was already moved on by another sweep', async () => {
    videoRepository.find.mockResolvedValue([
      {
        id: VIDEO_ID,
        storage_key: 'videos/x/source.mp4',
        upload_id: 'up-1',
        updated_at: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
    videoRepository.update.mockResolvedValue({ affected: 0 });

    await expect(service.cleanupAbandonedUploads()).resolves.toBe(0);
  });
});
