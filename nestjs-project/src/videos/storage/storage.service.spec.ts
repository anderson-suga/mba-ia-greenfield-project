import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import { StorageUnavailableException } from '../../common/exceptions/domain.exception';
import { S3StorageService } from './s3-storage.service';

interface MockClient {
  config: { endpoint?: string };
  send: jest.Mock;
}

const mockSend = jest.fn<Promise<unknown>, [unknown]>();
const mockClients: MockClient[] = [];
const mockGetSignedUrl = jest.fn<Promise<string>, unknown[]>();

jest.mock('@aws-sdk/client-s3', () => {
  const actual =
    jest.requireActual<Record<string, unknown>>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation((config: { endpoint?: string }) => {
      const client: MockClient = { config, send: mockSend };
      mockClients.push(client);
      return client;
    }),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]): Promise<string> =>
    mockGetSignedUrl(...args),
}));

type StorageConfig = ConfigType<typeof storageConfig>;

const buildConfig = (overrides: Partial<StorageConfig> = {}): StorageConfig =>
  ({
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'streamtube',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    presignExpiresIn: 3600,
    ...overrides,
  }) as StorageConfig;

/** Clients are created in constructor order: [0] internal, [1] public. */
const internalClient = (): MockClient => mockClients[0];
const publicClient = (): MockClient => mockClients[1];

const lastCommand = <T>(): T => mockSend.mock.calls[0][0] as T;

describe('S3StorageService', () => {
  let service: S3StorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClients.length = 0;
    mockSend.mockResolvedValue({});
    mockGetSignedUrl.mockResolvedValue('https://signed.example/object');
    service = new S3StorageService(buildConfig());
  });

  describe('client wiring', () => {
    it('should build one client per endpoint', () => {
      expect(mockClients).toHaveLength(2);
      expect(internalClient().config.endpoint).toBe('http://minio:9000');
      expect(publicClient().config.endpoint).toBe('http://localhost:9000');
    });

    it('should use path-style addressing on both clients for MinIO', () => {
      for (const client of mockClients) {
        expect(client.config).toMatchObject({
          forcePathStyle: true,
          region: 'us-east-1',
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        });
      }
    });
  });

  describe('multipart', () => {
    it('should create a multipart upload with the bucket, key and content type', async () => {
      mockSend.mockResolvedValue({ UploadId: 'upload-123' });

      const result = await service.createMultipartUpload(
        'videos/abc/source.mp4',
        'video/mp4',
      );

      expect(result).toEqual({ uploadId: 'upload-123' });
      const command = lastCommand<CreateMultipartUploadCommand>();
      expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
      expect(command.input).toEqual({
        Bucket: 'streamtube',
        Key: 'videos/abc/source.mp4',
        ContentType: 'video/mp4',
      });
    });

    it('should surface a 503 when storage returns no UploadId', async () => {
      mockSend.mockResolvedValue({});

      await expect(
        service.createMultipartUpload('k', 'video/mp4'),
      ).rejects.toThrow(StorageUnavailableException);
    });

    it('should presign a part url with the public client and the configured TTL', async () => {
      const url = await service.createPartUploadUrl('k', 'upload-1', 7);

      expect(url).toBe('https://signed.example/object');
      const [client, command, options] = mockGetSignedUrl.mock.calls[0] as [
        MockClient,
        UploadPartCommand,
        { expiresIn: number },
      ];
      // Upload URLs are consumed by the browser, so they must never carry the
      // internal host.
      expect(client).toBe(publicClient());
      expect(command).toBeInstanceOf(UploadPartCommand);
      expect(command.input).toEqual({
        Bucket: 'streamtube',
        Key: 'k',
        UploadId: 'upload-1',
        PartNumber: 7,
      });
      expect(options.expiresIn).toBe(3600);
    });

    it('should sort parts by part number before completing', async () => {
      await service.completeMultipartUpload('k', 'upload-1', [
        { partNumber: 3, etag: 'etag-3' },
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
      ]);

      const command = lastCommand<CompleteMultipartUploadCommand>();
      expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
      expect(command.input.MultipartUpload?.Parts).toEqual([
        { PartNumber: 1, ETag: 'etag-1' },
        { PartNumber: 2, ETag: 'etag-2' },
        { PartNumber: 3, ETag: 'etag-3' },
      ]);
    });

    it('should abort a multipart upload', async () => {
      await service.abortMultipartUpload('k', 'upload-1');

      const command = lastCommand<AbortMultipartUploadCommand>();
      expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
      expect(command.input).toEqual({
        Bucket: 'streamtube',
        Key: 'k',
        UploadId: 'upload-1',
      });
    });
  });

  describe('object access', () => {
    it('should read the real object size from headObject', async () => {
      mockSend.mockResolvedValue({
        ContentLength: 10_737_418_240,
        ContentType: 'video/mp4',
      });

      const head = await service.headObject('k');

      expect(head).toEqual({ size: 10_737_418_240, contentType: 'video/mp4' });
      expect(lastCommand<HeadObjectCommand>()).toBeInstanceOf(
        HeadObjectCommand,
      );
    });

    it('should default a missing content type to null', async () => {
      mockSend.mockResolvedValue({});

      const head = await service.headObject('k');

      expect(head).toEqual({ size: 0, contentType: null });
    });

    it('should forward a byte range when reading an object', async () => {
      const body = { pipe: jest.fn() };
      mockSend.mockResolvedValue({ Body: body });

      const result = await service.getObject('k', 'bytes=0-1023');

      expect(result).toBe(body);
      const command = lastCommand<GetObjectCommand>();
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'streamtube',
        Key: 'k',
        Range: 'bytes=0-1023',
      });
    });

    it('should omit the range header when none is given', async () => {
      mockSend.mockResolvedValue({ Body: {} });

      await service.getObject('k');

      const command = lastCommand<GetObjectCommand>();
      expect(command.input.Range).toBeUndefined();
    });

    it('should put an object with its content type', async () => {
      await service.putObject('thumb.jpg', Buffer.from('jpeg'), 'image/jpeg');

      const command = lastCommand<PutObjectCommand>();
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'streamtube',
        Key: 'thumb.jpg',
        ContentType: 'image/jpeg',
      });
    });

    it('should delete an object', async () => {
      await service.deleteObject('k');

      expect(lastCommand<DeleteObjectCommand>()).toBeInstanceOf(
        DeleteObjectCommand,
      );
    });
  });

  describe('getPresignedReadUrl', () => {
    it('should sign with the public client by default', async () => {
      await service.getPresignedReadUrl('videos/abc/source.mp4');

      const [client] = mockGetSignedUrl.mock.calls[0] as [MockClient];
      expect(client).toBe(publicClient());
    });

    it('should sign with the internal client when internal is true', async () => {
      await service.getPresignedReadUrl('videos/abc/source.mp4', {
        internal: true,
      });

      const [client] = mockGetSignedUrl.mock.calls[0] as [MockClient];
      // A container resolving the public endpoint would reach itself.
      expect(client).toBe(internalClient());
    });

    it('should mark the response inline when no download name is given', async () => {
      await service.getPresignedReadUrl('k');

      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        MockClient,
        GetObjectCommand,
      ];
      expect(command.input.ResponseContentDisposition).toBe('inline');
    });

    it('should mark the response as an attachment carrying the download name', async () => {
      await service.getPresignedReadUrl('k', { downloadName: 'lesson-01.mp4' });

      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        MockClient,
        GetObjectCommand,
      ];
      expect(command.input.ResponseContentDisposition).toBe(
        'attachment; filename="lesson-01.mp4"',
      );
    });

    it('should strip characters that could break out of the Content-Disposition header', async () => {
      await service.getPresignedReadUrl('k', {
        downloadName: 'evil"; DROP\r\nX-Injected: 1',
      });

      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        MockClient,
        GetObjectCommand,
      ];
      const disposition = command.input.ResponseContentDisposition ?? '';
      expect(disposition).not.toContain('\r');
      expect(disposition).not.toContain('\n');
      expect(disposition.match(/"/g)).toHaveLength(2);
      expect(disposition).toBe(
        'attachment; filename="evil; DROPX-Injected: 1"',
      );
    });

    it('should fall back to a generic name when sanitizing leaves nothing', async () => {
      await service.getPresignedReadUrl('k', { downloadName: '///' });

      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        MockClient,
        GetObjectCommand,
      ];
      expect(command.input.ResponseContentDisposition).toBe(
        'attachment; filename="___"',
      );
    });

    it('should honour an explicit expiry override', async () => {
      await service.getPresignedReadUrl('k', { expiresIn: 120 });

      const [, , options] = mockGetSignedUrl.mock.calls[0] as [
        MockClient,
        GetObjectCommand,
        { expiresIn: number },
      ];
      expect(options.expiresIn).toBe(120);
    });
  });

  describe('error mapping', () => {
    it('should map an unreachable endpoint to a 503', async () => {
      const error = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      mockSend.mockRejectedValue(error);

      await expect(service.headObject('k')).rejects.toThrow(
        StorageUnavailableException,
      );
    });

    it('should map a transport failure the SDK wrapped in a cause chain', async () => {
      const inner = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const wrapper = Object.assign(
        new Error('AWS SDK error wrapper for Error: connect ECONNREFUSED'),
        { cause: inner },
      );
      mockSend.mockRejectedValue(wrapper);

      await expect(service.headObject('k')).rejects.toThrow(
        StorageUnavailableException,
      );
    });

    it('should map a request timeout to a 503', async () => {
      const error = Object.assign(new Error('timed out'), {
        name: 'TimeoutError',
      });
      mockSend.mockRejectedValue(error);

      await expect(service.deleteObject('k')).rejects.toThrow(
        StorageUnavailableException,
      );
    });

    it('should let genuine storage errors propagate unchanged', async () => {
      const error = Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValue(error);

      await expect(service.headObject('k')).rejects.toThrow('NoSuchKey');
    });
  });
});
