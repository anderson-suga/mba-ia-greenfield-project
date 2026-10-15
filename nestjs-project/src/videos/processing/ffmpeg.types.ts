/** Shape of `ffprobe -print_format json` output, narrowed to what this phase reads. */
export interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  duration?: string;
  r_frame_rate?: string;
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/** Aggregated probe result, persisted in `videos.metadata`. */
export interface MediaMetadata {
  container: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  bit_rate: number | null;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    frame_rate: string | null;
  } | null;
  audio: {
    codec: string | null;
    sample_rate: number | null;
    channels: number | null;
  } | null;
}

/**
 * Raised when ffprobe/ffmpeg runs to completion but rejects the input — a
 * truncated file, an unsupported codec, a container it cannot parse. These are
 * properties of the file, so retrying the same input reproduces them.
 */
export class InvalidMediaError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

/** Raised when the child process could not be started, or had to be killed. */
export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

/** Keeps diagnostic output bounded before it reaches the database. */
export function truncateStderr(stderr: string, maxLength = 500): string {
  const trimmed = stderr.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength)}…`;
}
