import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Video } from '../../entities/video.entity';
import { OUTBOX_STATUS, type OutboxStatus } from '../video-processing.types';

/**
 * Transactional outbox.
 *
 * A row is inserted in the *same* transaction that moves a video out of `draft`,
 * so the intent to enqueue is committed atomically with the state change. The
 * relay then publishes it to BullMQ. Redis being down at completion time costs
 * latency, never a job: the row simply stays `pending` until the next tick.
 */
@Entity('video_processing_outbox')
@Index('IDX_video_processing_outbox_status_created_at', [
  'status',
  'created_at',
])
@Index('IDX_video_processing_outbox_video_id', ['video_id'])
export class VideoProcessingOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Becomes the BullMQ `jobId`, which is what makes dispatch idempotent. */
  @Column({ type: 'uuid', unique: true })
  event_id: string;

  @Column({ type: 'uuid' })
  video_id: string;

  @Column({ type: 'varchar', length: 20, default: OUTBOX_STATUS.PENDING })
  status: OutboxStatus;

  /** Dispatch attempts made by the relay (not processing attempts). */
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  /** Pointer payload: `{ video_id, storage_key }`. The consumer re-reads the row. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** Lease timestamp, so two relays cannot both dispatch the same row. */
  @Column({ type: 'timestamptz', nullable: true })
  claimed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  dispatched_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;

  /** Dispatch failure detail — not a processing failure. */
  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn()
  created_at: Date;

  /** Outbox rows are meaningless without their video, so they follow it out. */
  @ManyToOne(() => Video, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
