/** A part already uploaded to storage, as reported back by the client. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartUploadRef {
  uploadId: string;
}

export interface ObjectHead {
  /** Real size in bytes, as stored — this is what the 10GB limit is checked against. */
  size: number;
  contentType: string | null;
}

export interface CreatePartUploadUrlOptions {
  expiresIn?: number;
}

export interface PresignedReadUrlOptions {
  expiresIn?: number;
  /** When set, the URL is signed as an attachment with this filename. */
  downloadName?: string;
  /**
   * Sign against the internal endpoint (`STORAGE_ENDPOINT`, e.g. `http://minio:9000`)
   * instead of the public one. Required for any process running inside the Compose
   * network — most importantly the worker handing a URL to FFmpeg, where a
   * `localhost` URL would resolve to the container itself and fail with ECONNREFUSED.
   */
  internal?: boolean;
}
