import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

type EntityClass = new () => unknown;

export function createTestDataSource(
  entities: (EntityClass | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

/**
 * Wipes every table the suites touch.
 *
 * Order matters: it follows the foreign keys, so children go before parents.
 * `videos` references `channels`, so it must be cleared first — otherwise the
 * `DELETE FROM "channels"` is rejected by the `ON DELETE RESTRICT` constraint.
 */
export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM "video_processing_outbox"');
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
