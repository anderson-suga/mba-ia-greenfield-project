import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingOutbox } from '../videos/queue/entities/video-processing-outbox.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1792017811572 } from './migrations/1792017811572-CreateVideos';
import { CreateVideoProcessingOutbox1792018237254 } from './migrations/1792018237254-CreateVideoProcessingOutbox';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
  'video_processing_outbox',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [
        User,
        Channel,
        RefreshToken,
        VerificationToken,
        Video,
        VideoProcessingOutbox,
      ],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1792017811572,
          CreateVideoProcessingOutbox1792018237254,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential, not concurrent: these tables are linked by foreign keys, and
    // dropping them in parallel deadlocks against each other's locks.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // `DROP TABLE` does not remove the enum the auth migration creates, so a
    // re-run would fail with "type ... already exists".
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."verification_tokens_type_enum" CASCADE`,
    );
  });

  afterAll(async () => {
    // The revert test undoes the newest migration, leaving a table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all six tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(4);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'video_processing_outbox',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the outbox table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1`,
      ['video_processing_outbox'],
    );
    expect(result).toHaveLength(0);
  });

  it('should recreate the outbox table and its event_id uniqueness on re-run', async () => {
    await dataSource.runMigrations();

    const constraints = await dataSource.query<
      { conname: string; contype: string }[]
    >(
      `SELECT conname, contype FROM pg_constraint
       WHERE conrelid = 'video_processing_outbox'::regclass
       ORDER BY conname`,
    );

    const names = constraints.map((c) => c.conname);
    // One of these is the UNIQUE constraint that makes event_id the dedup key.
    expect(names).toHaveLength(3);
    expect(names.some((name) => name.startsWith('UQ_'))).toBe(true);
    expect(names.some((name) => name.startsWith('PK_'))).toBe(true);
    expect(names.some((name) => name.startsWith('FK_'))).toBe(true);
  });

  it('should create the videos table with its status check constraint', async () => {
    const constraints = await dataSource.query<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'videos'::regclass
       ORDER BY conname`,
    );

    const names = constraints.map((c) => c.conname);
    expect(names).toContain('CHK_videos_status');
    expect(names).toContain('UQ_39a1f0fe7991162aace659078ec');
  });
});
