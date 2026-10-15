import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import { S3StorageService } from './s3-storage.service';
import { MAX_PART_SIZE_BYTES } from '../videos.constants';

/**
 * Exercises the storage port against the real MinIO service from Compose — no
 * mocks, per the project rule that infrastructure which can genuinely run should
 * not be simulated.
 */

const ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';
const PUBLIC_ENDPOINT =
  process.env.STORAGE_PUBLIC_ENDPOINT ?? 'http://localhost:9000';

const buildConfig = (
  overrides: Partial<ConfigType<typeof storageConfig>> = {},
): ConfigType<typeof storageConfig> =>
  ({
    endpoint: ENDPOINT,
    publicEndpoint: PUBLIC_ENDPOINT,
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube123',
    presignExpiresIn: 3600,
    ...overrides,
  }) as ConfigType<typeof storageConfig>;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

describe('S3StorageService (integration, real MinIO)', () => {
  let service: S3StorageService;
  /**
   * Part-upload URLs are signed for the browser, so their host is the *public*
   * endpoint — which this test process (inside the API container) cannot reach.
   * This second instance signs against the internal endpoint instead, letting the
   * multipart flow be exercised for real from where the test actually runs. The
   * signing logic under test is identical; only the configured host differs.
   */
  let containerReachableService: S3StorageService;
  const createdKeys: string[] = [];

  /** Unique per run so repeated suites never collide on a key. */
  const newKey = (suffix: string): string => {
    const key = `tests/${randomUUID()}/${suffix}`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(() => {
    service = new S3StorageService(buildConfig());
    containerReachableService = new S3StorageService(
      buildConfig({ publicEndpoint: ENDPOINT }),
    );
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      try {
        await service.deleteObject(key);
      } catch {
        // Best-effort cleanup: a key that was never written has nothing to remove.
      }
    }
    service.onModuleDestroy();
    containerReachableService.onModuleDestroy();
  });

  describe('multipart upload', () => {
    it('should complete a multipart upload and report the exact assembled size', async () => {
      const key = newKey('source.mp4');
      const partOne = Buffer.alloc(5 * 1024 ** 2, 'a');
      const partTwo = Buffer.alloc(1024, 'b');

      const { uploadId } =
        await containerReachableService.createMultipartUpload(key, 'video/mp4');
      expect(uploadId).toBeTruthy();

      const firstUrl = await containerReachableService.createPartUploadUrl(
        key,
        uploadId,
        1,
      );
      const secondUrl = await containerReachableService.createPartUploadUrl(
        key,
        uploadId,
        2,
      );

      const firstResponse = await fetch(firstUrl, {
        method: 'PUT',
        body: partOne,
      });
      const secondResponse = await fetch(secondUrl, {
        method: 'PUT',
        body: partTwo,
      });
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const firstEtag = firstResponse.headers.get('etag') ?? '';
      const secondEtag = secondResponse.headers.get('etag') ?? '';
      expect(firstEtag).not.toBe('');

      await service.completeMultipartUpload(key, uploadId, [
        { partNumber: 2, etag: secondEtag },
        { partNumber: 1, etag: firstEtag },
      ]);

      const head = await service.headObject(key);

      expect(head.size).toBe(partOne.length + partTwo.length);
      expect(head.contentType).toBe('video/mp4');
    });

    it('should discard an aborted multipart upload', async () => {
      const key = newKey('aborted.mp4');
      const { uploadId } =
        await containerReachableService.createMultipartUpload(key, 'video/mp4');

      const url = await containerReachableService.createPartUploadUrl(
        key,
        uploadId,
        1,
      );
      await fetch(url, { method: 'PUT', body: Buffer.alloc(1024, 'c') });

      await service.abortMultipartUpload(key, uploadId);

      // Nothing was completed, so the object must not exist.
      await expect(service.headObject(key)).rejects.toThrow();
    });
  });

  describe('object round trip', () => {
    it('should write, read back and delete an object', async () => {
      const key = newKey('thumbnail.jpg');
      const payload = Buffer.from('fake-jpeg-bytes');

      await service.putObject(key, payload, 'image/jpeg');

      const head = await service.headObject(key);
      expect(head.size).toBe(payload.length);
      expect(head.contentType).toBe('image/jpeg');

      const readBack = await readAll(await service.getObject(key));
      expect(readBack.equals(payload)).toBe(true);

      await service.deleteObject(key);
      await expect(service.headObject(key)).rejects.toThrow();
    });

    it('should read a byte range from an object', async () => {
      const key = newKey('ranged.bin');
      const payload = Buffer.from('0123456789');

      await service.putObject(key, payload, 'application/octet-stream');

      const ranged = await readAll(await service.getObject(key, 'bytes=2-5'));

      expect(ranged.toString()).toBe('2345');
    });
  });

  describe('presigned read urls', () => {
    it('should serve an internal presigned url over HTTP', async () => {
      const key = newKey('served.mp4');
      const payload = Buffer.from('stream-me');

      await service.putObject(key, payload, 'video/mp4');

      const url = await service.getPresignedReadUrl(key, { internal: true });
      expect(new URL(url).host).toBe(new URL(ENDPOINT).host);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
        'stream-me',
      );
    });

    it('should answer a ranged request through the presigned url with 206', async () => {
      const key = newKey('ranged-stream.mp4');
      const payload = Buffer.alloc(4096, 'x');

      await service.putObject(key, payload, 'video/mp4');

      const url = await service.getPresignedReadUrl(key, { internal: true });
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-1023/${payload.length}`,
      );
      expect(response.headers.get('accept-ranges')).toBe('bytes');
    });

    it('should answer an unsatisfiable range with 416', async () => {
      const key = newKey('suffix.mp4');
      await service.putObject(key, Buffer.alloc(1024, 'y'), 'video/mp4');

      const url = await service.getPresignedReadUrl(key, { internal: true });
      const response = await fetch(url, {
        headers: { Range: `bytes=${1024 * 1024}-` },
      });

      expect(response.status).toBe(416);
    });

    it('should sign browser-facing urls against the public endpoint', async () => {
      const key = newKey('public.mp4');
      await service.putObject(key, Buffer.from('x'), 'video/mp4');

      const url = await service.getPresignedReadUrl(key);

      // The API container cannot reach the public host (it is the host machine),
      // so only the signed host is asserted here.
      expect(new URL(url).host).toBe(new URL(PUBLIC_ENDPOINT).host);
    });

    it('should carry the attachment disposition for a download url', async () => {
      const key = newKey('download.mp4');
      await service.putObject(key, Buffer.from('x'), 'video/mp4');

      const url = await service.getPresignedReadUrl(key, {
        internal: true,
        downloadName: 'my-lesson.mp4',
      });

      const response = await fetch(url);

      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(response.headers.get('content-disposition')).toContain(
        'my-lesson.mp4',
      );
    });
  });

  describe('error handling', () => {
    it('should report an unreachable endpoint as a domain 503', async () => {
      // A closed port on loopback refuses immediately, where an unresolvable
      // hostname would stall on DNS.
      const unreachable = new S3StorageService(
        buildConfig({
          endpoint: 'http://127.0.0.1:1',
          publicEndpoint: 'http://127.0.0.1:1',
        }),
      );

      try {
        await expect(unreachable.headObject('anything')).rejects.toMatchObject({
          errorCode: 'STORAGE_UNAVAILABLE',
          httpStatus: 503,
        });
      } finally {
        unreachable.onModuleDestroy();
      }
    }, 30_000);

    it('should keep the part size ceiling above the S3 minimum', () => {
      // Guards the multipart configuration the upload endpoints rely on.
      expect(MAX_PART_SIZE_BYTES).toBeGreaterThanOrEqual(5 * 1024 ** 2);
    });
  });
});
