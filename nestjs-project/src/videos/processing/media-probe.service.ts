import { Injectable, Logger } from '@nestjs/common';
import { InvalidMediaError, truncateStderr } from './ffmpeg.types';
import type { FfprobeOutput, MediaMetadata } from './ffmpeg.types';
import { runProcess } from './process-runner';

/** ffprobe reads only headers, but a slow storage endpoint still needs a bound. */
const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);

  /**
   * Extracts duration and stream metadata.
   *
   * The input is a URL, not a local path: storage serves it over HTTP with range
   * support, so ffprobe reads what it needs instead of downloading the file.
   */
  async probe(
    inputUrl: string,
    signal?: AbortSignal,
  ): Promise<{ durationSeconds: number | null; metadata: MediaMetadata }> {
    const result = await runProcess(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputUrl,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS, signal },
    );

    if (result.exitCode !== 0) {
      // A non-zero exit here means ffprobe could not make sense of the input —
      // the same bytes will fail the same way, so this is not retryable.
      throw new InvalidMediaError(
        'ffprobe could not read the uploaded file',
        truncateStderr(result.stderr),
      );
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(result.stdout.toString()) as FfprobeOutput;
    } catch {
      throw new InvalidMediaError(
        'ffprobe returned output that is not valid JSON',
        truncateStderr(result.stdout.toString()),
      );
    }

    const metadata = this.buildMetadata(parsed);

    if (metadata.duration_seconds === null) {
      throw new InvalidMediaError('the file reports no duration');
    }

    this.logger.log(
      `probed ${metadata.container ?? 'unknown container'} (${metadata.duration_seconds}s)`,
    );

    return { durationSeconds: metadata.duration_seconds, metadata };
  }

  private buildMetadata(parsed: FfprobeOutput): MediaMetadata {
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const format = parsed.format;

    const duration =
      toNumber(format?.duration) ?? (video ? toNumber(video.duration) : null);

    return {
      container: format?.format_name ?? null,
      duration_seconds: duration === null ? null : Math.round(duration),
      size_bytes: toNumber(format?.size),
      bit_rate: toNumber(format?.bit_rate),
      video: video
        ? {
            codec: video.codec_name ?? null,
            width: video.width ?? null,
            height: video.height ?? null,
            frame_rate: video.r_frame_rate ?? null,
          }
        : null,
      audio: audio
        ? {
            codec: audio.codec_name ?? null,
            sample_rate: toNumber(audio.sample_rate),
            channels: audio.channels ?? null,
          }
        : null,
    };
  }
}
