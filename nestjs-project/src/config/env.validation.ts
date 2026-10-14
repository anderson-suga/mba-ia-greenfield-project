import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  STORAGE_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  STORAGE_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_BUCKET: Joi.string().default('streamtube'),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_PRESIGN_EXPIRES_IN: Joi.number().min(1).default(3600),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  QUEUE_ATTEMPTS: Joi.number().min(1).default(3),
  QUEUE_BACKOFF_MS: Joi.number().min(0).default(30000),
  QUEUE_LOCK_DURATION_MS: Joi.number().min(1).default(1800000),
  QUEUE_STALLED_INTERVAL_MS: Joi.number().min(1).default(60000),
  QUEUE_MAX_STALLED_COUNT: Joi.number().min(0).default(1),
  QUEUE_RELAY_INTERVAL_MS: Joi.number().min(1).default(3000),
  QUEUE_RELAY_CLAIM_LEASE_MS: Joi.number().min(1).default(60000),
  QUEUE_RELAY_BATCH_SIZE: Joi.number().min(1).default(25),
  QUEUE_MAINTENANCE_INTERVAL_MS: Joi.number().min(1).default(900000),
  QUEUE_STALE_UPLOAD_HOURS: Joi.number().min(1).default(24),
  QUEUE_STALLED_PROCESSING_MS: Joi.number().min(1).default(7200000),
});
