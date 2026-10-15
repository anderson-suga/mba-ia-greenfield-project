import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

interface ValidationOutcome {
  error?: ValidationError;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): ValidationOutcome =>
  // `ValidationResult.value` is typed `any` by Joi; narrow it once here so the
  // assertions below read against a known shape instead of `any`.
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as ValidationOutcome;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it('should reject a missing STORAGE_ENDPOINT', () => {
    const { STORAGE_ENDPOINT, ...withoutEndpoint } = requiredEnv;
    void STORAGE_ENDPOINT;

    const { error } = envValidationSchema.validate(withoutEndpoint, {
      allowUnknown: true,
      abortEarly: false,
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should reject a STORAGE_ENDPOINT that is not a URI', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'minio:9000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should reject a missing storage credential', () => {
    const { STORAGE_SECRET_ACCESS_KEY, ...withoutSecret } = requiredEnv;
    void STORAGE_SECRET_ACCESS_KEY;

    const { error } = envValidationSchema.validate(withoutSecret, {
      allowUnknown: true,
      abortEarly: false,
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_ACCESS_KEY');
  });

  it('should default the storage region, bucket and presign TTL', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_BUCKET).toBe('streamtube');
    expect(value.STORAGE_PRESIGN_EXPIRES_IN).toBe(3600);
  });

  it('should default the Redis host to the Compose service name', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should default the queue retry and lock settings', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.QUEUE_ATTEMPTS).toBe(3);
    expect(value.QUEUE_BACKOFF_MS).toBe(30000);
    expect(value.QUEUE_LOCK_DURATION_MS).toBe(1800000);
    expect(value.QUEUE_MAX_STALLED_COUNT).toBe(1);
    expect(value.QUEUE_RELAY_CLAIM_LEASE_MS).toBe(60000);
    expect(value.QUEUE_RELAY_BATCH_SIZE).toBe(25);
  });

  it('should reject a non-numeric queue setting', () => {
    const { error } = validate({ QUEUE_ATTEMPTS: 'many' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_ATTEMPTS');
  });

  it('should reject a queue attempt count below one', () => {
    const { error } = validate({ QUEUE_ATTEMPTS: '0' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_ATTEMPTS');
  });
});
