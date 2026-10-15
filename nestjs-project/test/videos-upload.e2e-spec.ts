import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { ConfigType } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import storageConfig from '../src/config/storage.config';
import { S3StorageService } from '../src/videos/storage/s3-storage.service';
import { VideoProcessingOutbox } from '../src/videos/queue/entities/video-processing-outbox.entity';
import { VIDEO_STATUS } from '../src/videos/videos.constants';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

interface InitBody {
  id: string;
  public_id: string;
  title: string;
  status: string;
  upload_id: string;
  part_size: number;
  part_count: number;
  created_at: string;
}

const ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  /**
   * Part URLs handed to clients are signed for the browser host, which this
   * process cannot reach. This signs the same parts for the internal host so the
   * real bytes can be uploaded — the API under test is unaware of the difference.
   */
  let internalSigner: S3StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirrors main.ts — global pipes and filters are not applied by default.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    internalSigner = new S3StorageService({
      endpoint: ENDPOINT,
      publicEndpoint: ENDPOINT,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube123',
      presignExpiresIn: 3600,
    } as ConfigType<typeof storageConfig>);
  });

  afterAll(async () => {
    internalSigner.onModuleDestroy();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function loginAs(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailService = (
      authService as unknown as {
        mailService: { sendConfirmationEmail: (...args: string[]) => void };
      }
    ).mailService;

    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, confirmation: string) => {
          token = confirmation;
        },
      );

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });

    return (login.body as { access_token: string }).access_token;
  }

  async function initUpload(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<InitBody> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Lesson one',
        filename: 'lesson.mp4',
        size_bytes: 5 * 1024 ** 2,
        mime_type: 'video/mp4',
        ...overrides,
      })
      .expect(201);

    return response.body as InitBody;
  }

  describe('POST /videos', () => {
    it('should pre-register the video as a draft and open a multipart upload', async () => {
      const token = await loginAs('uploader@example.com');

      const body = await initUpload(token);

      expect(body.status).toBe(VIDEO_STATUS.DRAFT);
      expect(body.public_id).toHaveLength(11);
      expect(body.upload_id).toBeTruthy();
      expect(body.part_size).toBe(8 * 1024 ** 2);

      const row = await dataSource.query<
        { status: string; channel_id: string }[]
      >(`SELECT status FROM "videos" WHERE "id" = $1`, [body.id]);
      expect(row[0].status).toBe(VIDEO_STATUS.DRAFT);
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'x',
          filename: 'x.mp4',
          size_bytes: 1,
          mime_type: 'video/mp4',
        })
        .expect(401);
    });

    it('should return 415 for a media type outside the allowlist', async () => {
      const token = await loginAs('badmime@example.com');

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'x',
          filename: 'x.avi',
          size_bytes: 1024,
          mime_type: 'video/x-msvideo',
        })
        .expect(400);

      expect((response.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('should return 413 when the declared size exceeds 10GB', async () => {
      const token = await loginAs('toobig@example.com');

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Huge',
          filename: 'huge.mp4',
          size_bytes: 10 * 1024 ** 3 + 1,
          mime_type: 'video/mp4',
        })
        .expect(413);

      expect((response.body as ErrorBody).error).toBe('PAYLOAD_TOO_LARGE');
    });

    it('should accept exactly the 10GB limit', async () => {
      const token = await loginAs('exactlimit@example.com');

      const body = await initUpload(token, { size_bytes: 10 * 1024 ** 3 });

      expect(body.status).toBe(VIDEO_STATUS.DRAFT);
    });

    it('should reject unknown fields', async () => {
      const token = await loginAs('extrafield@example.com');

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'x',
          filename: 'x.mp4',
          size_bytes: 1024,
          mime_type: 'video/mp4',
          channel_id: 'someone-elses-channel',
        })
        .expect(400);

      expect((response.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/parts', () => {
    it('should presign the requested parts', async () => {
      const token = await loginAs('parts@example.com');
      const video = await initUpload(token);

      const response = await request(app.getHttpServer())
        .post(`/videos/${video.id}/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1, 2] })
        .expect(200);

      const parts = (
        response.body as { parts: { part_number: number; url: string }[] }
      ).parts;
      expect(parts).toHaveLength(2);
      expect(parts[0].part_number).toBe(1);
      // Browser-facing URLs must never carry the internal Docker host.
      expect(new URL(parts[0].url).host).not.toContain('minio:9000');
    });

    it('should return 400 when part_numbers is empty', async () => {
      const token = await loginAs('emptyparts@example.com');
      const video = await initUpload(token);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [] })
        .expect(400);
    });

    it('should return 400 when a part number is out of range', async () => {
      const token = await loginAs('badpart@example.com');
      const video = await initUpload(token);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [10001] })
        .expect(400);
    });

    it('should return 404 for an unknown video', async () => {
      const token = await loginAs('unknownvideo@example.com');

      const response = await request(app.getHttpServer())
        .post(`/videos/${randomUUID()}/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] })
        .expect(404);

      expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 403 for a video owned by another channel', async () => {
      const ownerToken = await loginAs('owner@example.com');
      const intruderToken = await loginAs('intruder@example.com');
      const video = await initUpload(ownerToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${video.id}/parts`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send({ part_numbers: [1] })
        .expect(403);

      expect((response.body as ErrorBody).error).toBe('VIDEO_FORBIDDEN');
    });
  });

  describe('POST /videos/:id/complete', () => {
    /**
     * Uploads the parts for real: the API opens the multipart upload and signs the
     * URLs for the browser, and this uploads the bytes against the same
     * key/uploadId signed for the internal host, which is what a browser does
     * from the other side of the network.
     */
    async function uploadParts(
      video: InitBody,
      chunk: Buffer,
    ): Promise<{ part_number: number; etag: string }[]> {
      const key = `videos/${video.id}/source.mp4`;
      const url = await internalSigner.createPartUploadUrl(
        key,
        video.upload_id,
        1,
      );

      // `fetch` does not accept a Buffer directly in the DOM body types.
      const upload = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(chunk),
      });
      expect(upload.status).toBe(200);

      return [{ part_number: 1, etag: upload.headers.get('etag') ?? '' }];
    }

    it('should accept the upload and move the video to processing', async () => {
      const token = await loginAs('complete@example.com');
      const video = await initUpload(token, { size_bytes: 1024 });
      const parts = await uploadParts(video, Buffer.alloc(1024, 'a'));

      const response = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      expect((response.body as { status: string }).status).toBe(
        VIDEO_STATUS.PROCESSING,
      );

      const rows = await dataSource.query<
        { status: string; size_bytes: string; upload_id: string | null }[]
      >(
        `SELECT "status", "size_bytes", "upload_id" FROM "videos" WHERE "id" = $1`,
        [video.id],
      );
      expect(rows[0].status).toBe(VIDEO_STATUS.PROCESSING);
      // The size persisted is the one measured on the stored object.
      expect(Number(rows[0].size_bytes)).toBe(1024);
      expect(rows[0].upload_id).toBeNull();
    });

    it('should record the outbox event in the same transaction as the status change', async () => {
      const token = await loginAs('outbox@example.com');
      const video = await initUpload(token, { size_bytes: 2048 });
      const parts = await uploadParts(video, Buffer.alloc(2048, 'b'));

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      const outbox = await dataSource
        .getRepository(VideoProcessingOutbox)
        .findOneBy({ video_id: video.id });

      expect(outbox).not.toBeNull();
      expect(outbox?.status).toBe('pending');
      expect(outbox?.payload).toEqual({
        video_id: video.id,
        storage_key: `videos/${video.id}/source.mp4`,
      });
    });

    it('should return 409 when the upload is completed twice', async () => {
      const token = await loginAs('double@example.com');
      const video = await initUpload(token, { size_bytes: 1024 });
      const parts = await uploadParts(video, Buffer.alloc(1024, 'c'));

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      const response = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);

      expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_DRAFT');

      const outboxCount = await dataSource
        .getRepository(VideoProcessingOutbox)
        .countBy({ video_id: video.id });
      // A replayed completion must not enqueue a second job.
      expect(outboxCount).toBe(1);
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post(`/videos/${randomUUID()}/complete`)
        .send({ parts: [{ part_number: 1, etag: 'x' }] })
        .expect(401);
    });

    it('should return 409 for a video that was already aborted', async () => {
      const token = await loginAs('aborted@example.com');
      const video = await initUpload(token);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const response = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: 'x' }] })
        .expect(409);

      expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_DRAFT');
    });
  });

  describe('POST /videos/:id/abort', () => {
    it('should abort the upload and mark the draft as errored', async () => {
      const token = await loginAs('abort@example.com');
      const video = await initUpload(token);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rows = await dataSource.query<
        { status: string; error_code: string | null }[]
      >(`SELECT "status", "error_code" FROM "videos" WHERE "id" = $1`, [
        video.id,
      ]);
      expect(rows[0].status).toBe(VIDEO_STATUS.ERROR);
      expect(rows[0].error_code).toBe('UPLOAD_ABORTED');
    });

    it('should return 403 for a video owned by another channel', async () => {
      const ownerToken = await loginAs('abortowner@example.com');
      const intruderToken = await loginAs('abortintruder@example.com');
      const video = await initUpload(ownerToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${video.id}/abort`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .expect(403);

      expect((response.body as ErrorBody).error).toBe('VIDEO_FORBIDDEN');
    });

    it('should return 404 for an unknown video', async () => {
      const token = await loginAs('abort404@example.com');

      await request(app.getHttpServer())
        .post(`/videos/${randomUUID()}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });
});
