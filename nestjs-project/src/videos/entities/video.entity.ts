import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ValueTransformer } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  VIDEO_STATUS,
  VIDEO_STATUSES,
  VIDEO_STATUS_CHECK_CONSTRAINT,
  type VideoStatus,
} from '../videos.constants';

/** Derived from the status constant so the database check cannot drift from the code. */
const STATUS_CHECK_EXPRESSION = `"status" IN (${VIDEO_STATUSES.map((s) => `'${s}'`).join(', ')})`;

/**
 * `pg` returns `bigint` as a string to avoid silent precision loss. Video sizes
 * top out at 10GB — far below `Number.MAX_SAFE_INTEGER` — so converting at the
 * driver boundary keeps the application type a plain number.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
@Check(VIDEO_STATUS_CHECK_CONSTRAINT, STATUS_CHECK_EXPRESSION)
@Index('IDX_videos_channel_id', ['channel_id'])
@Index('IDX_videos_status', ['status'])
export class Video {
  /** Internal identifier — used in foreign keys and storage keys, never exposed publicly. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** URL-facing identifier. Opaque, short, and unique across all videos. */
  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 20, default: VIDEO_STATUS.DRAFT })
  status: VideoStatus;

  /** `videos/{id}/source.mp4` — server-assigned, derived from the UUID. */
  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  /** `videos/{id}/thumbnail.jpg` — written by the worker once a frame is rendered. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** S3 multipart UploadId; cleared when the upload completes or is aborted. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  /** Measured with HeadObject, not taken from the client's declaration. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  size_bytes: number | null;

  @Column({ type: 'varchar', length: 127, nullable: true })
  mime_type: string | null;

  /** Aggregated ffprobe output: codecs, resolution, bitrate. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  error_code: string | null;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  /**
   * Owning side only. The inverse (`Channel#videos`) is deliberately omitted:
   * nothing in this phase traverses channel → videos, and declaring it would
   * require every existing test data source that registers `Channel` to also
   * register `Video`.
   */
  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
