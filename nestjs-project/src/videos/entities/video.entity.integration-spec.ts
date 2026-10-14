import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VIDEO_STATUS } from '../videos.constants';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );

    return channelRepository.save(
      channelRepository.create({
        name: `Owner ${n}`,
        nickname: `owner_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    const n = ++counter;
    return videoRepository.create({
      public_id: `pubId${String(n).padStart(6, '0')}`,
      channel_id: channelId,
      title: `Video ${n}`,
      storage_key: `videos/00000000-0000-0000-0000-00000000000${n % 10}/source.mp4`,
      ...overrides,
    });
  }

  it('should generate a uuid primary key and both timestamps', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(buildVideo(channel.id));

    expect(video.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should default the status to draft', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(buildVideo(channel.id));

    expect(video.status).toBe(VIDEO_STATUS.DRAFT);
  });

  it('should leave the worker-owned columns null on creation', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(buildVideo(channel.id));

    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.mime_type).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.error_code).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should enforce the unique public_id constraint', async () => {
    const channel = await createChannel();
    const publicId = 'xQ3fK9mLp2A';

    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a status outside the four-state lifecycle', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { status: 'uploading' as never }),
      ),
    ).rejects.toThrow(/CHK_videos_status|check constraint/i);
  });

  it('should accept every status in the lifecycle', async () => {
    const channel = await createChannel();

    for (const status of Object.values(VIDEO_STATUS)) {
      const video = await videoRepository.save(
        buildVideo(channel.id, { status }),
      );
      expect(video.status).toBe(status);
    }
  });

  it('should round-trip size_bytes as a number rather than the driver string', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: MAX_VIDEO_SIZE_BYTES }),
    );

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(typeof reloaded.size_bytes).toBe('number');
    expect(reloaded.size_bytes).toBe(MAX_VIDEO_SIZE_BYTES);
  });

  it('should persist the ffprobe metadata object as jsonb', async () => {
    const channel = await createChannel();
    const metadata = {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: 176.32,
      streams: [{ codec_name: 'h264', width: 1920, height: 1080 }],
    };

    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );

    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.metadata).toEqual(metadata);
  });

  it('should reject a public_id longer than 11 characters', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { public_id: 'a'.repeat(12) }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should load the owning channel through the many-to-one relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });

  it('should refuse to delete a channel that still owns videos', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id));

    await expect(channelRepository.delete({ id: channel.id })).rejects.toThrow(
      QueryFailedError,
    );
  });

  it('should find videos by public_id, the lookup the read endpoints use', async () => {
    const channel = await createChannel();
    const publicId = 'aB3dE5fG7hJ';
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    const found = await videoRepository.findOneBy({ public_id: publicId });

    expect(found).not.toBeNull();
    expect(found?.public_id).toBe(publicId);
  });
});
