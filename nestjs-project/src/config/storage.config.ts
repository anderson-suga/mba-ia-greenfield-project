import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  /**
   * Endpoint reachable from inside the Compose network (`http://minio:9000`).
   * Used for every server-side operation and for presigned URLs the worker consumes.
   */
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  /**
   * Endpoint reachable from the browser (`http://localhost:9000`). Only ever used
   * to sign URLs handed to a client — never resolved by a container, where
   * `localhost` would point at the container itself.
   */
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
  presignExpiresIn: parseInt(
    process.env.STORAGE_PRESIGN_EXPIRES_IN || '3600',
    10,
  ),
}));
