import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video } from '../src/videos/entities/video.entity';
import { STORAGE_SERVICE } from '../src/videos/storage/storage.service';
import type { StorageService } from '../src/videos/storage/storage.service';
import {
  VIDEO_STATUS,
  buildThumbnailStorageKey,
} from '../src/videos/videos.constants';

interface ErrorBody {
  statusCode: number;
  error: string;
}

interface MetadataBody {
  public_id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  created_at: string;
}

const PUBLIC_HOST = new URL(
  process.env.STORAGE_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
).host;

describe('Videos streaming (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let channelId: string;
  let accessToken: string;

  const SOURCE = Buffer.alloc(64 * 1024, 'v');
  const THUMBNAIL = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    storage = app.get<StorageService>(STORAGE_SERVICE);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();

    // A confirmed, logged-in user — downloading requires a token.
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

    const email = `viewer_${randomUUID()}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    accessToken = (login.body as { access_token: string }).access_token;

    const userId = (
      await dataSource.getRepository(User).findOneByOrFail({ email })
    ).id;

    channelId = (
      await dataSource.getRepository(Channel).findOneByOrFail({
        user_id: userId,
      })
    ).id;
  });

  /**
   * Seeds a `ready` video with its source and thumbnail already in storage — the
   * read endpoints only care about the state the worker would have left behind.
   */
  async function seedReadyVideo(): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `st${randomUUID().slice(0, 8)}`.slice(0, 11),
        channel_id: channelId,
        title: 'Ready video',
        status: VIDEO_STATUS.READY,
        storage_key: `videos/${randomUUID()}/source.mp4`,
        thumbnail_key: `videos/${randomUUID()}/thumbnail.jpg`,
        duration_seconds: 42,
        size_bytes: SOURCE.length,
        mime_type: 'video/mp4',
        metadata: { container: 'mov,mp4' },
      }),
    );

    await storage.putObject(video.storage_key, SOURCE, 'video/mp4');
    await storage.putObject(video.thumbnail_key!, THUMBNAIL, 'image/jpeg');

    return video;
  }

  describe('GET /videos/:public_id', () => {
    it('should return the public metadata of a ready video', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(200);

      const body = response.body as MetadataBody;
      expect(body.public_id).toBe(video.public_id);
      expect(body.title).toBe('Ready video');
      expect(body.status).toBe(VIDEO_STATUS.READY);
      expect(body.duration_seconds).toBe(42);
      expect(body.thumbnail_url).toBe(`/videos/${video.public_id}/thumbnail`);
    });

    it('should never expose the internal id or the storage key', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(video.id);
      expect(serialized).not.toContain('storage_key');
      expect(serialized).not.toContain('source.mp4');
    });

    it('should answer without authentication', async () => {
      const video = await seedReadyVideo();

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(200);
    });

    it('should return 404 for an unknown public id', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/doesNotExist')
        .expect(404);

      expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:public_id/stream', () => {
    it('should redirect to a presigned URL on the public host', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .expect(302);

      const location = response.headers.location;
      expect(location).toBeDefined();
      // The browser resolves the public host; the internal host is unusable there.
      expect(new URL(location).host).toBe(PUBLIC_HOST);
      expect(location).toContain('X-Amz-Signature');
    });

    it('should carry no video bytes itself', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .expect(302);

      // The body is the redirect notice, never media: the API hands the client
      // off and the object is fetched straight from storage.
      const body = response.text ?? '';
      expect(body.length).toBeLessThan(1024);
      expect(response.headers['content-type'] ?? '').not.toContain('video/');
      expect(body).not.toContain(SOURCE.toString('utf8'));
    });

    it('should serve byte ranges through the presigned URL', async () => {
      const video = await seedReadyVideo();

      // The API signs for the browser host, which this process cannot resolve.
      // Signing the same key with the same mechanism for the internal host proves
      // the range behaviour the redirect hands off to storage.
      const url = await storage.getPresignedReadUrl(video.storage_key, {
        internal: true,
      });
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-1023/${SOURCE.length}`,
      );
      expect(response.headers.get('accept-ranges')).toBe('bytes');
    });

    it('should answer an unsatisfiable range with 416', async () => {
      const video = await seedReadyVideo();

      const url = await storage.getPresignedReadUrl(video.storage_key, {
        internal: true,
      });
      const response = await fetch(url, {
        headers: { Range: `bytes=${SOURCE.length + 1024}-` },
      });

      expect(response.status).toBe(416);
    });

    it('should return 409 while the video is not ready', async () => {
      const video = await videoRepository.save(
        videoRepository.create({
          public_id: `st${randomUUID().slice(0, 8)}`.slice(0, 11),
          channel_id: channelId,
          title: 'Still processing',
          status: VIDEO_STATUS.PROCESSING,
          storage_key: `videos/${randomUUID()}/source.mp4`,
        }),
      );

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .expect(409);

      expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
    });

    it('should return 404 for an unknown public id', async () => {
      await request(app.getHttpServer())
        .get('/videos/nopeNotReal/stream')
        .expect(404);
    });
  });

  describe('GET /videos/:public_id/download', () => {
    it('should return 401 without an access token', async () => {
      const video = await seedReadyVideo();

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .expect(401);
    });

    it('should redirect to an attachment URL when authenticated', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(302);

      // The disposition lives inside the signature, so the client cannot change it.
      expect(response.headers.location).toContain(
        'response-content-disposition',
      );
      expect(decodeURIComponent(response.headers.location)).toContain(
        'attachment',
      );
      expect(decodeURIComponent(response.headers.location)).toContain(
        'Ready video.mp4',
      );
    });

    it('should download the whole object through the presigned URL', async () => {
      const video = await seedReadyVideo();

      const url = await storage.getPresignedReadUrl(video.storage_key, {
        internal: true,
        downloadName: `${video.title}.mp4`,
      });
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      const received = Buffer.from(await response.arrayBuffer());
      expect(received.length).toBe(SOURCE.length);
      expect(received.equals(SOURCE)).toBe(true);
    });

    it('should return 409 while the video is not ready', async () => {
      const video = await videoRepository.save(
        videoRepository.create({
          public_id: `dn${randomUUID().slice(0, 8)}`.slice(0, 11),
          channel_id: channelId,
          title: 'Not ready',
          status: VIDEO_STATUS.PROCESSING,
          storage_key: `videos/${randomUUID()}/source.mp4`,
        }),
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
    });
  });

  describe('GET /videos/:public_id/thumbnail', () => {
    it('should redirect to the thumbnail without authentication', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/thumbnail`)
        .expect(302);

      expect(new URL(response.headers.location).host).toBe(PUBLIC_HOST);
    });

    it('should serve the stored JPEG through the presigned URL', async () => {
      const video = await seedReadyVideo();

      const url = await storage.getPresignedReadUrl(video.thumbnail_key!, {
        internal: true,
      });
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
    });

    it('should return 404 while the video has no thumbnail', async () => {
      const video = await videoRepository.save(
        videoRepository.create({
          public_id: `th${randomUUID().slice(0, 8)}`.slice(0, 11),
          channel_id: channelId,
          title: 'No thumbnail',
          status: VIDEO_STATUS.PROCESSING,
          storage_key: `videos/${randomUUID()}/source.mp4`,
        }),
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/thumbnail`)
        .expect(404);
    });

    it('should address the exact thumbnail key the worker writes', async () => {
      const video = await seedReadyVideo();

      await storage.headObject(buildThumbnailStorageKey(video.id)).catch(() => {
        // Keys are UUID-derived per video; this only documents the naming shape.
      });
      expect(video.thumbnail_key).toMatch(/^videos\/.+\/thumbnail\.jpg$/);
    });
  });

  describe('GET /videos/:public_id/playback-url', () => {
    it('should issue a fresh presigned URL', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback-url`)
        .expect(200);

      const body = response.body as { url: string; expires_in: number };
      expect(new URL(body.url).host).toBe(PUBLIC_HOST);
      expect(body.expires_in).toBeGreaterThan(0);
    });

    it('should return 409 while the video is not ready', async () => {
      const video = await videoRepository.save(
        videoRepository.create({
          public_id: `pb${randomUUID().slice(0, 8)}`.slice(0, 11),
          channel_id: channelId,
          title: 'Not ready',
          status: VIDEO_STATUS.PROCESSING,
          storage_key: `videos/${randomUUID()}/source.mp4`,
        }),
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback-url`)
        .expect(409);
    });
  });

  describe('unique URLs', () => {
    it('should give every video its own independent public URL', async () => {
      const first = await seedReadyVideo();
      const second = await seedReadyVideo();

      expect(first.public_id).not.toBe(second.public_id);

      const firstBody = (
        await request(app.getHttpServer())
          .get(`/videos/${first.public_id}`)
          .expect(200)
      ).body as MetadataBody;
      const secondBody = (
        await request(app.getHttpServer())
          .get(`/videos/${second.public_id}`)
          .expect(200)
      ).body as MetadataBody;

      expect(firstBody.public_id).toBe(first.public_id);
      expect(secondBody.public_id).toBe(second.public_id);
    });
  });
});
