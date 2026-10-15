import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { InvalidMediaError } from './ffmpeg.types';
import { MediaProbeService } from './media-probe.service';
import {
  createCorruptFile,
  createSampleVideo,
  describeWithFfmpeg,
} from './test-media.util';

const ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';

describeWithFfmpeg('MediaProbeService (integration, real ffprobe)', () => {
  const probe = new MediaProbeService();
  let storage: S3StorageService;
  const createdKeys: string[] = [];
  let workDir: string;

  beforeAll(async () => {
    storage = new S3StorageService({
      endpoint: ENDPOINT,
      publicEndpoint: ENDPOINT,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube123',
      presignExpiresIn: 3600,
    } as ConfigType<typeof storageConfig>);

    workDir = await mkdtemp(join(tmpdir(), 'streamtube-probe-'));
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      try {
        await storage.deleteObject(key);
      } catch {
        // Best-effort: a key that was never written has nothing to remove.
      }
    }
    storage.onModuleDestroy();
    await rm(workDir, { recursive: true, force: true });
  });

  async function urlFor(payload: Buffer, name: string): Promise<string> {
    const key = `tests/probe/${randomUUID()}/${name}`;
    createdKeys.push(key);
    await storage.putObject(key, payload, 'video/mp4');
    return storage.getPresignedReadUrl(key, { internal: true });
  }

  it('should read duration and stream details from a real file over HTTP', async () => {
    const url = await urlFor(await createSampleVideo(2), 'sample.mp4');

    const result = await probe.probe(url);

    expect(result.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(result.durationSeconds).toBeLessThanOrEqual(3);
    expect(result.metadata.video?.codec).toBe('h264');
    expect(result.metadata.video?.width).toBe(320);
    expect(result.metadata.video?.height).toBe(240);
    expect(result.metadata.audio?.codec).toBe('aac');
    expect(result.metadata.container).toContain('mp4');
  });

  it('should reject a file that is not decodable media', async () => {
    const url = await urlFor(createCorruptFile(), 'corrupt.mp4');

    await expect(probe.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('should fail when the object does not exist', async () => {
    const url = await storage.getPresignedReadUrl(
      `tests/probe/${randomUUID()}/missing.mp4`,
      { internal: true },
    );

    await expect(probe.probe(url)).rejects.toThrow();
  });

  it('should probe a file that exists only on disk', async () => {
    // Guards the argv plumbing itself, independent of the storage round trip.
    const path = join(workDir, `${randomUUID()}.mp4`);
    await writeFile(path, await createSampleVideo(1));

    const result = await probe.probe(path);

    expect(result.metadata.video?.codec).toBe('h264');
  });
});
