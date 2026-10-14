import { randomUUID } from 'node:crypto';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { InvalidMediaError } from './ffmpeg.types';
import { ThumbnailService } from './thumbnail.service';
import {
  createCorruptFile,
  createSampleVideo,
  describeWithFfmpeg,
} from './test-media.util';

const ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describeWithFfmpeg('ThumbnailService (integration, real ffmpeg)', () => {
  const thumbnail = new ThumbnailService();
  let storage: S3StorageService;
  const createdKeys: string[] = [];

  beforeAll(() => {
    storage = new S3StorageService({
      endpoint: ENDPOINT,
      publicEndpoint: ENDPOINT,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube123',
      presignExpiresIn: 3600,
    } as ConfigType<typeof storageConfig>);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      try {
        await storage.deleteObject(key);
      } catch {
        // Best-effort cleanup.
      }
    }
    storage.onModuleDestroy();
  });

  async function urlFor(payload: Buffer, name: string): Promise<string> {
    const key = `tests/thumbnail/${randomUUID()}/${name}`;
    createdKeys.push(key);
    await storage.putObject(key, payload, 'video/mp4');
    return storage.getPresignedReadUrl(key, { internal: true });
  }

  it('should render a JPEG from a frame of a real file', async () => {
    const url = await urlFor(await createSampleVideo(4), 'sample.mp4');

    const image = await thumbnail.generate(url, 4);

    expect(image.length).toBeGreaterThan(0);
    expect(image.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)).toBe(true);
  });

  it('should seek past the opening frame', async () => {
    const url = await urlFor(await createSampleVideo(10), 'longer.mp4');

    // 10% of 10s — the frame is taken a second in, not at the very start.
    const image = await thumbnail.generate(url, 10);

    expect(image.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)).toBe(true);
  });

  it('should handle a zero duration without seeking', async () => {
    const url = await urlFor(await createSampleVideo(1), 'short.mp4');

    const image = await thumbnail.generate(url, 0);

    expect(image.length).toBeGreaterThan(0);
  });

  it('should reject a file that is not decodable media', async () => {
    const url = await urlFor(createCorruptFile(), 'corrupt.mp4');

    await expect(thumbnail.generate(url, 2)).rejects.toBeInstanceOf(
      InvalidMediaError,
    );
  });
});
