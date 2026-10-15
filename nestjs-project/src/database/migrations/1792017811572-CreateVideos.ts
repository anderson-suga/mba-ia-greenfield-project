import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1792017811572 implements MigrationInterface {
  name = 'CreateVideos1792017811572';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'draft', "storage_key" character varying(512) NOT NULL, "thumbnail_key" character varying(512), "upload_id" character varying(255), "duration_seconds" integer, "size_bytes" bigint, "mime_type" character varying(127), "metadata" jsonb, "error_code" character varying(64), "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "CHK_videos_status" CHECK ("status" IN ('draft', 'processing', 'ready', 'error')), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status" ON "videos" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_status"`);
    await queryRunner.query(`DROP TABLE "videos"`);
  }
}
