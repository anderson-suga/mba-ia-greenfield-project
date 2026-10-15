import type { Readable } from 'node:stream';
import type {
  CompletedPart,
  CreatePartUploadUrlOptions,
  MultipartUploadRef,
  ObjectHead,
  PresignedReadUrlOptions,
} from './storage.types';

/**
 * Injection token for the storage port. Consumers depend on this interface and on
 * the token — never on `@aws-sdk/*`, which stays confined to `s3-storage.service.ts`.
 */
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

/**
 * Object storage abstraction over S3/MinIO.
 *
 * Every method takes a fully-formed key; keys are the caller's responsibility and
 * are always derived from the video's internal UUID (see `videos.constants.ts`),
 * never from client-supplied input.
 */
export interface StorageService {
  /** Opens a multipart upload and returns its id, which the video row stores. */
  createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<MultipartUploadRef>;

  /** Presigns a single `UploadPart`, so the client PUTs the bytes straight to storage. */
  createPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    options?: CreatePartUploadUrlOptions,
  ): Promise<string>;

  /** Finalises a multipart upload. Part numbers must be unique; they are sorted internally. */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void>;

  /** Discards an in-flight multipart upload and frees its parts. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /** Reads object metadata without transferring the body. */
  headObject(key: string): Promise<ObjectHead>;

  /** Reads an object, optionally a byte range (e.g. `bytes=0-1023`). */
  getObject(key: string, range?: string): Promise<Readable>;

  /** Writes a whole object. Used for the worker's thumbnail. */
  putObject(
    key: string,
    body: Buffer | Readable,
    contentType: string,
  ): Promise<void>;

  deleteObject(key: string): Promise<void>;

  /**
   * Presigns a GET. Signs against the public endpoint by default and the internal
   * one when `internal` is true — see `PresignedReadUrlOptions.internal`.
   */
  getPresignedReadUrl(
    key: string,
    options?: PresignedReadUrlOptions,
  ): Promise<string>;
}
