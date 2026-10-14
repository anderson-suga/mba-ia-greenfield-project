import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const MANAGED_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_PUBLIC_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_PRESIGN_EXPIRES_IN',
];

describe('storageConfig', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  const loadConfig = async (): Promise<ConfigType<typeof storageConfig>> => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
      ],
    }).compile();

    const config = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    await module.close();
    return config;
  };

  it('should fall back to the Compose service names and non-secret defaults', async () => {
    const config = await loadConfig();

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://localhost:9000');
    expect(config.region).toBe('us-east-1');
    expect(config.bucket).toBe('streamtube');
    expect(config.presignExpiresIn).toBe(3600);
  });

  it('should read every configured value from the environment', async () => {
    process.env.STORAGE_ENDPOINT = 'http://storage:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'https://cdn.example.com';
    process.env.STORAGE_REGION = 'sa-east-1';
    process.env.STORAGE_BUCKET = 'other-bucket';
    process.env.STORAGE_ACCESS_KEY_ID = 'key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'secret';
    process.env.STORAGE_PRESIGN_EXPIRES_IN = '900';

    const config = await loadConfig();

    expect(config.endpoint).toBe('http://storage:9000');
    expect(config.publicEndpoint).toBe('https://cdn.example.com');
    expect(config.region).toBe('sa-east-1');
    expect(config.bucket).toBe('other-bucket');
    expect(config.accessKeyId).toBe('key');
    expect(config.secretAccessKey).toBe('secret');
    expect(config.presignExpiresIn).toBe(900);
  });

  it('should coerce STORAGE_PRESIGN_EXPIRES_IN into a number', async () => {
    process.env.STORAGE_PRESIGN_EXPIRES_IN = '120';

    const config = await loadConfig();

    expect(typeof config.presignExpiresIn).toBe('number');
    expect(config.presignExpiresIn).toBe(120);
  });

  it('should never default the internal endpoint to a loopback host', async () => {
    const config = await loadConfig();

    // Inside a container `localhost` resolves to the container itself, so an
    // internal endpoint defaulting to it would fail with ECONNREFUSED.
    expect(config.endpoint).not.toContain('localhost');
    expect(config.endpoint).not.toContain('127.0.0.1');
  });

  it('should expose a distinct public endpoint for browser-facing presigned URLs', async () => {
    const config = await loadConfig();

    expect(config.publicEndpoint).not.toBe(config.endpoint);
  });
});
