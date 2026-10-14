import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
// `DataSource` is used as a DI token (a value) as well as a type.
import { DataSource, QueryFailedError } from 'typeorm';
import type { Repository } from 'typeorm';
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
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { STORAGE_SERVICE } from './storage/storage.service';
import { VideoProcessingOutboxService } from './queue/video-processing-outbox.service';
import { VideosService } from './videos.service';
import { VIDEO_STATUS } from './videos.constants';

const CHANNEL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'user-1';
const VIDEO_ID = '11111111-1111-4111-8111-111111111111';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    public_id: 'xQ3fK9mLp2A',
    channel_id: CHANNEL_ID,
    title: 'Lesson',
    status: VIDEO_STATUS.DRAFT,
    storage_key: `videos/${VIDEO_ID}/source.mp4`,
    thumbnail_key: null,
    upload_id: 'upload-1',
    duration_seconds: null,
    size_bytes: 1024,
    mime_type: 'video/mp4',
    metadata: null,
    error_code: null,
    error_message: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Video;
}

const uniqueViolation = (): QueryFailedError => {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  (error as unknown as { code: string }).code = '23505';
  return error;
};

describe('VideosService', () => {
  let service: VideosService;

  const videoRepository = {
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const manager = {
    query: jest.fn(),
    save: jest.fn<Promise<unknown>, [unknown]>(),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    update: jest.fn(),
    findOneByOrFail: jest.fn(),
  };
  const dataSource = {
    // Typed against `unknown` so the mock manager does not have to satisfy the
    // full EntityManager surface; the service receives a real one at runtime.
    transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    createPartUploadUrl: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const outbox = { enqueueInTransaction: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    storage.createMultipartUpload.mockResolvedValue({ uploadId: 'upload-1' });
    storage.createPartUploadUrl.mockResolvedValue('https://signed/part');
    storage.headObject.mockResolvedValue({
      size: 1024,
      contentType: 'video/mp4',
    });
    // `save` returns the persisted entity, which includes the timestamp columns
    // the database fills in.
    manager.save.mockImplementation((data: unknown) =>
      Promise.resolve({
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        ...(data as object),
      }),
    );
    manager.query.mockResolvedValue(undefined);
    manager.update.mockResolvedValue({ affected: 1 });
    manager.findOneByOrFail.mockResolvedValue(
      buildVideo({ status: VIDEO_STATUS.PROCESSING, upload_id: null }),
    );
    outbox.enqueueInTransaction.mockResolvedValue({});

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository as unknown as Repository<Video>,
        },
        { provide: DataSource, useValue: dataSource as unknown as DataSource },
        { provide: ChannelsService, useValue: channelsService },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: VideoProcessingOutboxService, useValue: outbox },
        {
          provide: storageConfig.KEY,
          useValue: { presignExpiresIn: 3600, bucket: 'streamtube' },
        },
        {
          provide: queueConfig.KEY,
          useValue: { attempts: 3, backoffMs: 30000 },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initUpload', () => {
    const dto = {
      title: 'Lesson',
      filename: 'lesson.mp4',
      size_bytes: 10 * 1024 ** 2,
      mime_type: 'video/mp4',
    };

    it('should pre-register the video as a draft owned by the caller channel', async () => {
      const result = await service.initUpload(dto, USER_ID);

      expect(result.status).toBe(VIDEO_STATUS.DRAFT);
      expect(result.upload_id).toBe('upload-1');
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      const saved = manager.save.mock.calls[0][0] as Video;
      // The channel always comes from the authenticated user.
      expect(saved.channel_id).toBe(CHANNEL_ID);
      expect(saved.status).toBe(VIDEO_STATUS.DRAFT);
    });

    it('should derive the storage key from the video id, never the filename', async () => {
      const result = await service.initUpload(
        { ...dto, filename: '../../etc/passwd' },
        USER_ID,
      );

      const [key] = storage.createMultipartUpload.mock.calls[0] as [string];
      expect(key).toBe(`videos/${result.id}/source.mp4`);
      expect(key).not.toContain('passwd');
    });

    it('should report the part count for the declared size and part size', async () => {
      const result = await service.initUpload(
        { ...dto, size_bytes: 20 * 1024 ** 2, part_size: 8 * 1024 ** 2 },
        USER_ID,
      );

      expect(result.part_size).toBe(8 * 1024 ** 2);
      expect(result.part_count).toBe(3);
    });

    it('should regenerate the public id when the first one collides', async () => {
      manager.save
        .mockRejectedValueOnce(uniqueViolation())
        .mockImplementationOnce((data: unknown) =>
          Promise.resolve({
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            updated_at: new Date('2026-01-01T00:00:00.000Z'),
            ...(data as object),
          }),
        );

      const result = await service.initUpload(dto, USER_ID);

      expect(manager.query).toHaveBeenCalledWith(
        'ROLLBACK TO SAVEPOINT public_id_attempt_0',
      );
      expect(result.id).toBeDefined();
    });

    it('should abort the multipart upload when the draft cannot be persisted', async () => {
      manager.save.mockRejectedValue(new Error('database is down'));

      await expect(service.initUpload(dto, USER_ID)).rejects.toThrow(
        'database is down',
      );

      // Otherwise the already-open upload leaks parts into storage.
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringContaining('/source.mp4'),
        'upload-1',
      );
    });

    it('should reject a declared size above the 10GB limit before opening an upload', async () => {
      await expect(
        service.initUpload({ ...dto, size_bytes: 10 * 1024 ** 3 + 1 }, USER_ID),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should forbid the upload when the caller has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initUpload(dto, USER_ID)).rejects.toThrow(
        VideoForbiddenException,
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('createPartUrls', () => {
    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
    });

    it('should presign each requested part', async () => {
      const result = await service.createPartUrls(
        VIDEO_ID,
        { part_numbers: [1, 2] },
        USER_ID,
      );

      expect(result.parts).toHaveLength(2);
      expect(result.parts[0]).toEqual({
        part_number: 1,
        url: 'https://signed/part',
        expires_in: 3600,
      });
      expect(storage.createPartUploadUrl).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/source.mp4`,
        'upload-1',
        2,
      );
    });

    it('should reject a video owned by another channel', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });

      await expect(
        service.createPartUrls(VIDEO_ID, { part_numbers: [1] }, USER_ID),
      ).rejects.toThrow(VideoForbiddenException);
    });

    it('should reject an unknown video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.createPartUrls(VIDEO_ID, { part_numbers: [1] }, USER_ID),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should reject a video that is no longer a draft', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VIDEO_STATUS.PROCESSING }),
      );

      await expect(
        service.createPartUrls(VIDEO_ID, { part_numbers: [1] }, USER_ID),
      ).rejects.toThrow(VideoNotDraftException);
    });
  });

  describe('completeUpload', () => {
    const dto = { parts: [{ part_number: 1, etag: 'etag-1' }] };

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
    });

    it('should move the video to processing and record the outbox event', async () => {
      const result = await service.completeUpload(VIDEO_ID, dto, USER_ID);

      expect(result.status).toBe(VIDEO_STATUS.PROCESSING);
      expect(manager.update).toHaveBeenCalledWith(
        Video,
        { id: VIDEO_ID, status: VIDEO_STATUS.DRAFT },
        expect.objectContaining({ status: VIDEO_STATUS.PROCESSING }),
      );
      expect(outbox.enqueueInTransaction).toHaveBeenCalled();
    });

    it('should persist the size measured by headObject, not the declared one', async () => {
      storage.headObject.mockResolvedValue({ size: 999, contentType: null });

      await service.completeUpload(VIDEO_ID, dto, USER_ID);

      expect(manager.update).toHaveBeenCalledWith(
        Video,
        expect.anything(),
        expect.objectContaining({ size_bytes: 999 }),
      );
    });

    it('should reject an object that exceeds the 10GB limit and delete it', async () => {
      storage.headObject.mockResolvedValue({
        size: 10 * 1024 ** 3 + 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload(VIDEO_ID, dto, USER_ID),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(storage.deleteObject).toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('should report an incomplete upload when the object is missing', async () => {
      storage.headObject.mockRejectedValue(new Error('NoSuchKey'));

      await expect(
        service.completeUpload(VIDEO_ID, dto, USER_ID),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('should keep a storage outage a 503 rather than an incomplete upload', async () => {
      storage.headObject.mockRejectedValue(new StorageUnavailableException());

      await expect(
        service.completeUpload(VIDEO_ID, dto, USER_ID),
      ).rejects.toThrow(StorageUnavailableException);
    });

    it('should return a conflict when the guarded update matches no row', async () => {
      manager.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload(VIDEO_ID, dto, USER_ID),
      ).rejects.toThrow(VideoNotDraftException);

      // Nothing is enqueued for a completion that lost the race.
      expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
    });

    it('should map the request parts onto the storage contract', async () => {
      await service.completeUpload(
        VIDEO_ID,
        {
          parts: [
            { part_number: 2, etag: 'etag-2' },
            { part_number: 1, etag: 'etag-1' },
          ],
        },
        USER_ID,
      );

      const [key, uploadId, parts] = storage.completeMultipartUpload.mock
        .calls[0] as [string, string, { partNumber: number; etag: string }[]];
      expect(key).toBe(`videos/${VIDEO_ID}/source.mp4`);
      expect(uploadId).toBe('upload-1');
      // Ordering for S3 is the storage layer's responsibility (see
      // storage.service.spec.ts); here only the field mapping matters.
      expect(parts).toEqual([
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 1, etag: 'etag-1' },
      ]);
    });
  });

  describe('abortUpload', () => {
    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
    });

    it('should abort the multipart upload and mark the row as errored', async () => {
      await service.abortUpload(VIDEO_ID, USER_ID);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/source.mp4`,
        'upload-1',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VIDEO_STATUS.DRAFT },
        expect.objectContaining({
          status: VIDEO_STATUS.ERROR,
          error_code: 'UPLOAD_ABORTED',
        }),
      );
    });

    it('should refuse to abort a video that is not a draft', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VIDEO_STATUS.READY }),
      );

      await expect(service.abortUpload(VIDEO_ID, USER_ID)).rejects.toThrow(
        VideoNotDraftException,
      );
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
