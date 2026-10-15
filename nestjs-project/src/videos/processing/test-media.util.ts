import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process-runner';

/**
 * FFmpeg is installed only in the worker image, so the API container cannot run
 * the tests that shell out to it. Those suites skip there and run for real in
 * `nestjs-worker`; `progress.md` records which container produced the evidence.
 */
export function isFfmpegAvailable(): boolean {
  const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

export const describeWithFfmpeg = isFfmpegAvailable()
  ? describe
  : describe.skip;

/**
 * Renders a small H.264/AAC MP4 with FFmpeg and returns it in memory.
 *
 * Fixtures are generated rather than checked in: a real encoded file exercises
 * the same decode path as a user upload, and nothing binary has to live in the
 * repository. The temp directory is removed even when generation fails.
 */
export async function createSampleVideo(durationSeconds = 2): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  const outputPath = join(directory, 'sample.mp4');

  try {
    const result = await runProcess(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${durationSeconds}:size=320x240:rate=10`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${durationSeconds}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        outputPath,
      ],
      { timeoutMs: 60_000 },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `could not generate the sample video: ${result.stderr.trim()}`,
      );
    }

    return await readFile(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A file that is definitively not decodable media. */
export function createCorruptFile(): Buffer {
  return Buffer.from('this is definitely not an mp4 file');
}
