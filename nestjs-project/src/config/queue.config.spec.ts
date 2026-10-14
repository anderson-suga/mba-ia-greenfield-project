import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';

const MANAGED_KEYS = [
  'REDIS_HOST',
  'REDIS_PORT',
  'QUEUE_ATTEMPTS',
  'QUEUE_BACKOFF_MS',
  'QUEUE_LOCK_DURATION_MS',
  'QUEUE_STALLED_INTERVAL_MS',
  'QUEUE_MAX_STALLED_COUNT',
  'QUEUE_RELAY_INTERVAL_MS',
  'QUEUE_RELAY_CLAIM_LEASE_MS',
  'QUEUE_RELAY_BATCH_SIZE',
];

describe('queueConfig', () => {
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

  const loadConfig = async (): Promise<ConfigType<typeof queueConfig>> => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [queueConfig] }),
      ],
    }).compile();

    const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
    await module.close();
    return config;
  };

  it('should default the Redis host to the Compose service name', async () => {
    const config = await loadConfig();

    expect(config.redisHost).toBe('redis');
    expect(config.redisPort).toBe(6379);
  });

  it('should default the retry policy to three exponential attempts', async () => {
    const config = await loadConfig();

    expect(config.attempts).toBe(3);
    expect(config.backoffMs).toBe(30_000);
  });

  it('should default lockDuration above the BullMQ default so long FFmpeg jobs are not re-delivered', async () => {
    const config = await loadConfig();

    // BullMQ's default lock is 30s; a video transcode can run for minutes.
    expect(config.lockDurationMs).toBe(1_800_000);
    expect(config.lockDurationMs).toBeGreaterThan(30_000);
    expect(config.maxStalledCount).toBe(1);
  });

  it('should default the outbox relay poll interval and claim lease', async () => {
    const config = await loadConfig();

    expect(config.relayIntervalMs).toBe(3_000);
    expect(config.relayClaimLeaseMs).toBe(60_000);
    expect(config.relayBatchSize).toBe(25);
  });

  it('should read overrides from the environment and coerce them to numbers', async () => {
    process.env.REDIS_HOST = 'cache';
    process.env.REDIS_PORT = '6380';
    process.env.QUEUE_ATTEMPTS = '5';
    process.env.QUEUE_BACKOFF_MS = '1000';
    process.env.QUEUE_LOCK_DURATION_MS = '60000';
    process.env.QUEUE_MAX_STALLED_COUNT = '2';

    const config = await loadConfig();

    expect(config.redisHost).toBe('cache');
    expect(config.redisPort).toBe(6380);
    expect(config.attempts).toBe(5);
    expect(config.backoffMs).toBe(1000);
    expect(config.lockDurationMs).toBe(60_000);
    expect(config.maxStalledCount).toBe(2);
  });

  it('should never default the Redis host to a loopback address', async () => {
    const config = await loadConfig();

    expect(config.redisHost).not.toBe('localhost');
    expect(config.redisHost).not.toBe('127.0.0.1');
  });
});
