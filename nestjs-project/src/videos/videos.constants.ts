/**
 * Video lifecycle states.
 *
 * `draft` covers both "created, upload not started" and "upload in progress" —
 * a non-null `upload_id` distinguishes the two, so no extra state is needed.
 */
export const VIDEO_STATUS = {
  DRAFT: 'draft',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

export const VIDEO_STATUSES: readonly VideoStatus[] =
  Object.values(VIDEO_STATUS);

/** 10GB — the ceiling enforced on the declared size and re-checked against the stored object. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

/** 8MiB default: ~1,280 parts for a 10GB file, comfortably under S3's 10,000-part limit. */
export const DEFAULT_PART_SIZE_BYTES = 8 * 1024 ** 2;

/** S3 rejects any part smaller than 5MiB except the last one. */
export const MIN_PART_SIZE_BYTES = 5 * 1024 ** 2;

export const MAX_PART_SIZE_BYTES = 64 * 1024 ** 2;

export const MAX_PART_COUNT = 10_000;

export const ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** Length of the URL-facing identifier, in base62 characters (~65 bits). */
export const PUBLIC_ID_LENGTH = 11;

export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const VIDEOS_BUCKET_PREFIX = 'videos';

export const VIDEO_STATUS_CHECK_CONSTRAINT = 'CHK_videos_status';

/**
 * Storage keys are always derived from the internal UUID — never from a client
 * supplied filename or title, which would allow path traversal and overwrites.
 */
export const buildVideoStorageKey = (videoId: string): string =>
  `${VIDEOS_BUCKET_PREFIX}/${videoId}/source.mp4`;

export const buildThumbnailStorageKey = (videoId: string): string =>
  `${VIDEOS_BUCKET_PREFIX}/${videoId}/thumbnail.jpg`;
