import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import swaggerConfig from '../config/swagger.config';
import { envValidationSchema } from '../config/env.validation';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingOutbox } from '../videos/queue/entities/video-processing-outbox.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/queue/video-processing.queue';
import { VideoProcessingOutboxService } from '../videos/queue/video-processing-outbox.service';
import { S3StorageService } from '../videos/storage/s3-storage.service';
import { STORAGE_SERVICE } from '../videos/storage/storage.service';
import { MediaProbeService } from '../videos/processing/media-probe.service';
import { ThumbnailService } from '../videos/processing/thumbnail.service';
import { VideoProcessingProcessor } from '../videos/processing/video-processing.processor';

/**
 * Root module of the standalone worker process.
 *
 * It wires only what processing a video needs — configuration, the database, the
 * storage port, the queue, and the FFmpeg-backed services. `VideosModule` is
 * deliberately *not* imported: that would drag in the controller, the upload
 * service, and the outbox relay, none of which belong in this process. Sharing
 * the entity classes and the `StorageService` contract is what keeps the two
 * processes from drifting.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        queueConfig,
        storageConfig,
        swaggerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // `Video` relates to `Channel`, which relates to `User`, so the whole chain
    // has to be registered for the entity metadata to build. Registering the
    // entities directly keeps the worker free of the services that own them.
    TypeOrmModule.forFeature([User, Channel, Video, VideoProcessingOutbox]),
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
    MediaProbeService,
    ThumbnailService,
    VideoProcessingProcessor,
  ],
})
export class WorkerModule {}
