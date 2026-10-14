import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './queue/entities/video-processing-outbox.entity';
import { VIDEO_PROCESSING_QUEUE } from './queue/video-processing.queue';
import { VideoProcessingOutboxRelay } from './queue/video-processing-outbox.relay';
import { VideoProcessingOutboxService } from './queue/video-processing-outbox.service';
import { S3StorageService } from './storage/s3-storage.service';
import { STORAGE_SERVICE } from './storage/storage.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, VideoProcessingOutbox]),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.redisHost, port: config.redisPort },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [
    {
      provide: STORAGE_SERVICE,
      useClass: S3StorageService,
    },
    VideoProcessingOutboxService,
    VideoProcessingOutboxRelay,
  ],
  exports: [
    STORAGE_SERVICE,
    VideoProcessingOutboxService,
    VideoProcessingOutboxRelay,
  ],
})
export class VideosModule {}
