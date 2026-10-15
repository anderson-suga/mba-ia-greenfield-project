import { InvalidMediaError, ProcessExecutionError } from './ffmpeg.types';
import { StorageUnavailableException } from '../../common/exceptions/domain.exception';

export type FailureKind = 'recoverable' | 'unrecoverable';

/**
 * Error codes persisted in `videos.error_code` when a failure is terminal.
 * `PROCESSING_FAILED` is reserved for "attempts exhausted"; these describe a
 * failure that retrying cannot fix.
 */
export const UNRECOVERABLE_CODES = ['INVALID_MEDIA'] as const;

export const INVALID_MEDIA_ERROR_CODE = 'INVALID_MEDIA';
export const PROCESSING_FAILED_ERROR_CODE = 'PROCESSING_FAILED';

/**
 * Decides whether a processing failure is worth retrying.
 *
 * The distinction is a property of the cause, not of the error's type: an input
 * the decoder cannot understand will fail identically on every attempt, so
 * retrying only delays the terminal state and holds a worker slot. Transient
 * infrastructure problems — storage unreachable, a killed process — are the ones
 * a retry can actually fix.
 *
 * Defaults to `recoverable`, so an unrecognised error gets retried rather than
 * being written off on a guess.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof InvalidMediaError) {
    return 'unrecoverable';
  }

  // The worker could not start the binary or had to kill it: an environment
  // problem, which a later attempt may well not hit.
  if (error instanceof ProcessExecutionError) {
    return 'recoverable';
  }

  if (error instanceof StorageUnavailableException) {
    return 'recoverable';
  }

  return 'recoverable';
}

export function isUnrecoverable(error: unknown): boolean {
  return classifyFailure(error) === 'unrecoverable';
}
