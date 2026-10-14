import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entry point of the video worker container.
 *
 * `createApplicationContext` rather than `createNestApplication`: no HTTP server
 * is bound and the API's global guards never apply here. Shutdown hooks are
 * enabled so a `SIGTERM` from the container runtime tears the BullMQ connection
 * and any in-flight FFmpeg child process down cleanly.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  Logger.log(
    'Video worker started, listening on the processing queue',
    'Worker',
  );
}

void bootstrap();
