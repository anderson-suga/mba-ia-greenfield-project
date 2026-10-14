import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../../config/storage.config';
import { StorageUnavailableException } from '../../common/exceptions/domain.exception';
import type { StorageService } from './storage.service';
import type {
  CompletedPart,
  CreatePartUploadUrlOptions,
  MultipartUploadRef,
  ObjectHead,
  PresignedReadUrlOptions,
} from './storage.types';

/** Node/undici error codes that mean "the storage endpoint could not be reached". */
const UNAVAILABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

const MAX_CAUSE_DEPTH = 5;

function mentionsUnavailableCode(message: string): boolean {
  for (const code of UNAVAILABLE_ERROR_CODES) {
    if (message.includes(code)) return true;
  }
  return false;
}

/**
 * Recognises "the storage endpoint could not be reached" across the shapes the
 * SDK actually produces: a raw transport error carrying `code`, a timeout, a
 * wrapper exposing the code only through its cause chain, and a wrapper that
 * preserves it nowhere but the message.
 */
function isStorageUnavailable(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > MAX_CAUSE_DEPTH) {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  if (
    typeof candidate.code === 'string' &&
    UNAVAILABLE_ERROR_CODES.has(candidate.code)
  ) {
    return true;
  }

  if (
    candidate.name === 'TimeoutError' ||
    candidate.name === 'RequestTimeout'
  ) {
    return true;
  }

  if (
    typeof candidate.message === 'string' &&
    mentionsUnavailableCode(candidate.message)
  ) {
    return true;
  }

  return isStorageUnavailable(candidate.cause, depth + 1);
}

/**
 * Keeps client-supplied text out of the header structure: anything that could
 * terminate the quoted string or introduce a new header is removed.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/\p{Cc}/gu, '')
    .replace(/["\\]/g, '')
    .replace(/\//g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  const safe = cleaned.length > 0 ? cleaned : 'video';
  return safe.slice(0, 120);
}

@Injectable()
export class S3StorageService implements StorageService, OnModuleDestroy {
  /**
   * Two clients, because a presigned URL embeds the host of whoever signed it.
   * Server-side calls always go through the internal one; only URLs meant for a
   * browser are signed with the public one.
   */
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.internalClient = this.createClient(config.endpoint);
    this.publicClient = this.createClient(config.publicEndpoint);
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      // Since @aws-sdk/client-s3 3.729.0 the SDK computes CRC checksums on uploads
      // and validates them on responses by default. MinIO rejects those requests,
      // so both behaviours are turned off unless the operation demands a checksum.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Releases both connection pools so shutdown does not leave sockets open. */
  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  /** Converts unreachable-endpoint failures into the domain's 503. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isStorageUnavailable(error)) {
        throw new StorageUnavailableException();
      }
      throw error;
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<MultipartUploadRef> {
    return this.run(async () => {
      const result = await this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          ContentType: contentType,
        }),
      );

      if (!result.UploadId) {
        throw new StorageUnavailableException();
      }

      return { uploadId: result.UploadId };
    });
  }

  async createPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    options: CreatePartUploadUrlOptions = {},
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    // Upload URLs are always consumed by the client's browser, never by a container.
    return getSignedUrl(this.publicClient, command, {
      expiresIn: options.expiresIn ?? this.config.presignExpiresIn,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    // S3 requires parts in ascending PartNumber order.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.run(() =>
      this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      ),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.run(() =>
      this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    return this.run(async () => {
      const result = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );

      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
      };
    });
  }

  async getObject(key: string, range?: string): Promise<Readable> {
    return this.run(async () => {
      const result = await this.internalClient.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ...(range !== undefined && { Range: range }),
        }),
      );

      return result.Body as Readable;
    });
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    contentType: string,
  ): Promise<void> {
    await this.run(() =>
      this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      ),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.run(() =>
      this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
      ),
    );
  }

  async getPresignedReadUrl(
    key: string,
    options: PresignedReadUrlOptions = {},
  ): Promise<string> {
    const client = options.internal ? this.internalClient : this.publicClient;

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ResponseContentDisposition:
        options.downloadName !== undefined
          ? `attachment; filename="${sanitizeFilename(options.downloadName)}"`
          : 'inline',
    });

    return getSignedUrl(client, command, {
      expiresIn: options.expiresIn ?? this.config.presignExpiresIn,
    });
  }
}
