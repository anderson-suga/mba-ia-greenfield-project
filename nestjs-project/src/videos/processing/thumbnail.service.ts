import { Injectable, Logger } from '@nestjs/common';
import { InvalidMediaError, truncateStderr } from './ffmpeg.types';
import { runProcess } from './process-runner';

/** Rendering a frame from a large remote file needs headroom. */
const THUMBNAIL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Fraction of the duration to seek to. Seeking past the opening avoids the black
 * or title frame that most videos start on.
 */
const THUMBNAIL_OFFSET_RATIO = 0.1;

/** JPEG magic bytes — `FF D8 FF` starts every baseline JFIF image. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);

  /**
   * Renders a single frame as JPEG and returns it in memory.
   *
   * The image is written to `pipe:1` rather than a temp file, so nothing is left
   * on the worker's disk regardless of how the job ends.
   */
  async generate(
    inputUrl: string,
    durationSeconds: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const offsetSeconds = Math.max(
      0,
      Math.floor(durationSeconds * THUMBNAIL_OFFSET_RATIO),
    );

    const result = await runProcess(
      'ffmpeg',
      [
        // `-ss` before `-i` seeks by keyframe, which is far cheaper on a large
        // remote input than decoding from the start.
        '-ss',
        String(offsetSeconds),
        '-i',
        inputUrl,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-f',
        'image2',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { timeoutMs: THUMBNAIL_TIMEOUT_MS, signal },
    );

    if (result.exitCode !== 0) {
      throw new InvalidMediaError(
        'ffmpeg could not render a frame from the uploaded file',
        truncateStderr(result.stderr),
      );
    }

    if (result.stdout.length === 0) {
      throw new InvalidMediaError('ffmpeg produced an empty thumbnail');
    }

    if (!result.stdout.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
      throw new InvalidMediaError('ffmpeg output is not a JPEG image');
    }

    this.logger.log(
      `rendered thumbnail at ${offsetSeconds}s (${result.stdout.length} bytes)`,
    );

    return result.stdout;
  }
}
