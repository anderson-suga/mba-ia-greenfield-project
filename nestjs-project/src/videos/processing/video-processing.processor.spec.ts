import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { VideoProcessingJob } from '../queue/video-processing.types';
import type { Repository } from 'typeorm';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS, buildThumbnailStorageKey } from '../videos.constants';
import { STORAGE_SERVICE } from '../storage/storage.service';
import { VideoProcessingOutboxService } from '../queue/video-processing-outbox.service';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { InvalidMediaError } from './ffmpeg.types';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const STORAGE_KEY = `videos/${VIDEO_ID}/source.mp4`;

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    public_id: 'xQ3fK9mLp2A',
    channel_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Lesson',
    status: VIDEO_STATUS.PROCESSING,
    storage_key: STORAGE_KEY,
    thumbnail_key: null,
    upload_id: null,
    duration_seconds: null,
    size_bytes: 1024,
    mime_type: 'video/mp4',
    metadata: null,
    error_code: null,
    error_message: null,
    ...overrides,
  } as Video;
}

const buildJob = (overrides: Partial<Job> = {}): Job<VideoProcessingJob> =>
  ({
    id: 'job-1',
    name: 'video.process',
    data: { video_id: VIDEO_ID, storage_key: STORAGE_KEY, event_id: EVENT_ID },
    opts: { attempts: 3 },
    attemptsMade: 0,
    updateProgress: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as Job<VideoProcessingJob>;

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;

  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = {
    getPresignedReadUrl: jest.fn(),
    putObject: jest.fn(),
    headObject: jest.fn(),
  };
  const mediaProbe = { probe: jest.fn() };
  const thumbnail = { generate: jest.fn() };
  const outbox = { markProcessed: jest.fn(), markProcessedFailed: jest.fn() };

  const metadata = {
    container: 'mov,mp4',
    duration_seconds: 2,
    size_bytes: 1024,
    bit_rate: 1000,
    video: { codec: 'h264', width: 320, height: 240, frame_rate: '10/1' },
    audio: { codec: 'aac', sample_rate: 44100, channels: 1 },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    videoRepository.update.mockResolvedValue({ affected: 1 });
    storage.getPresignedReadUrl.mockResolvedValue('http://minio:9000/signed');
    storage.headObject.mockResolvedValue({
      size: 512,
      contentType: 'image/jpeg',
    });
    mediaProbe.probe.mockResolvedValue({ durationSeconds: 2, metadata });
    thumbnail.generate.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository as unknown as Repository<Video>,
        },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: MediaProbeService, useValue: mediaProbe },
        { provide: ThumbnailService, useValue: thumbnail },
        { provide: VideoProcessingOutboxService, useValue: outbox },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  describe('idempotency', () => {
    it('should do nothing when the video is no longer processing', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VIDEO_STATUS.READY }),
      );

      await expect(processor.process(buildJob())).resolves.toBeUndefined();

      // A redelivered job for a finished video must not redo the work.
      expect(mediaProbe.probe).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should do nothing when the video no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(processor.process(buildJob())).resolves.toBeUndefined();
      expect(mediaProbe.probe).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('should read the source through the internal presigned URL', async () => {
      await processor.process(buildJob());

      // A container resolving the public endpoint would reach itself.
      expect(storage.getPresignedReadUrl).toHaveBeenCalledWith(STORAGE_KEY, {
        internal: true,
      });
    });

    it('should render the thumbnail at the probed duration and store it', async () => {
      await processor.process(buildJob());

      expect(thumbnail.generate).toHaveBeenCalledWith(
        'http://minio:9000/signed',
        2,
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        buildThumbnailStorageKey(VIDEO_ID),
        expect.any(Buffer),
        'image/jpeg',
      );
    });

    it('should confirm the thumbnail exists before marking the video ready', async () => {
      await processor.process(buildJob());

      const headOrder = storage.headObject.mock.invocationCallOrder[0];
      const updateOrder = videoRepository.update.mock.invocationCallOrder[0];
      expect(headOrder).toBeLessThan(updateOrder);
    });

    it('should persist duration and metadata and mark the video ready', async () => {
      await processor.process(buildJob());

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VIDEO_STATUS.PROCESSING },
        expect.objectContaining({
          status: VIDEO_STATUS.READY,
          duration_seconds: 2,
          thumbnail_key: buildThumbnailStorageKey(VIDEO_ID),
        }),
      );
      expect(outbox.markProcessed).toHaveBeenCalledWith(EVENT_ID);
    });

    it('should report progress as it moves through the pipeline', async () => {
      const updateProgress = jest.fn().mockResolvedValue(undefined);
      const job = buildJob({ updateProgress } as Partial<
        Job<VideoProcessingJob>
      >);

      await processor.process(job);

      expect(updateProgress).toHaveBeenCalledWith(100);
    });
  });

  describe('failure handling', () => {
    it('should mark an undecodable file as INVALID_MEDIA and refuse to retry', async () => {
      mediaProbe.probe.mockRejectedValue(
        new InvalidMediaError('not decodable', 'stderr detail'),
      );

      await expect(processor.process(buildJob())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VIDEO_STATUS.PROCESSING },
        expect.objectContaining({
          status: VIDEO_STATUS.ERROR,
          error_code: 'INVALID_MEDIA',
        }),
      );
      expect(outbox.markProcessedFailed).toHaveBeenCalled();
    });

    it('should rethrow a transient failure so BullMQ retries it', async () => {
      mediaProbe.probe.mockRejectedValue(new Error('storage is slow'));

      await expect(processor.process(buildJob())).rejects.toThrow(
        'storage is slow',
      );

      // No terminal state yet: the attempts have not been exhausted.
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should reject a thumbnail that was written but is empty', async () => {
      storage.headObject.mockResolvedValue({ size: 0, contentType: null });

      await expect(processor.process(buildJob())).rejects.toThrow(
        'thumbnail was written but is empty',
      );
      expect(outbox.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should not write a terminal state while attempts remain', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 1, opts: { attempts: 3 } } as Partial<
          Job<VideoProcessingJob>
        >),
        new Error('boom'),
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should record PROCESSING_FAILED once the attempts are exhausted', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<
          Job<VideoProcessingJob>
        >),
        new Error('boom'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VIDEO_STATUS.PROCESSING },
        expect.objectContaining({
          status: VIDEO_STATUS.ERROR,
          error_code: 'PROCESSING_FAILED',
        }),
      );
      expect(outbox.markProcessedFailed).toHaveBeenCalledWith(EVENT_ID, 'boom');
    });

    it('should leave an already terminal video untouched', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await processor.onFailed(
        buildJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<
          Job<VideoProcessingJob>
        >),
        new Error('boom'),
      );

      expect(outbox.markProcessedFailed).not.toHaveBeenCalled();
    });
  });
});
