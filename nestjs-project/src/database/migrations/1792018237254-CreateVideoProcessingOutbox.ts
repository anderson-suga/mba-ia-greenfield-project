import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideoProcessingOutbox1792018237254 implements MigrationInterface {
  name = 'CreateVideoProcessingOutbox1792018237254';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "video_processing_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "event_id" uuid NOT NULL, "video_id" uuid NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "payload" jsonb NOT NULL, "claimed_at" TIMESTAMP WITH TIME ZONE, "dispatched_at" TIMESTAMP WITH TIME ZONE, "processed_at" TIMESTAMP WITH TIME ZONE, "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_6d4184c1b65f22918093098bd85" UNIQUE ("event_id"), CONSTRAINT "PK_39dcfd3c9dbeb68310241a09b72" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_video_processing_outbox_video_id" ON "video_processing_outbox" ("video_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_video_processing_outbox_status_created_at" ON "video_processing_outbox" ("status", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD CONSTRAINT "FK_b5164922ea5553e56eeb637863a" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP CONSTRAINT "FK_b5164922ea5553e56eeb637863a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_video_processing_outbox_status_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_video_processing_outbox_video_id"`,
    );
    await queryRunner.query(`DROP TABLE "video_processing_outbox"`);
  }
}
