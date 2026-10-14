import { randomBytes } from 'node:crypto';
import { PUBLIC_ID_LENGTH } from './videos.constants';

/** URL-safe alphabet: no characters that need escaping in a path segment. */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Bytes at or above this value are discarded. 248 is the largest multiple of 62
 * that fits in a byte, so rejecting the remainder keeps every character equally
 * likely instead of over-representing the first eight.
 */
const MAX_UNBIASED_BYTE = Math.floor(256 / BASE62.length) * BASE62.length;

/**
 * Generates an opaque, URL-safe public identifier.
 *
 * Uses `node:crypto` rather than a package: it is a built-in, so there is no
 * dependency to carry and no ESM/CJS failure mode to work around. Uniqueness is
 * still enforced by the database — callers retry on a unique violation.
 */
export function generatePublicId(length: number = PUBLIC_ID_LENGTH): string {
  let id = '';

  while (id.length < length) {
    for (const byte of randomBytes(length - id.length)) {
      if (byte >= MAX_UNBIASED_BYTE) continue;
      id += BASE62[byte % BASE62.length];
    }
  }

  return id;
}
