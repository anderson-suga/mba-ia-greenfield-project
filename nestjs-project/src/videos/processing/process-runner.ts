import { spawn } from 'node:child_process';
import { ProcessExecutionError } from './ffmpeg.types';

export interface RunProcessOptions {
  timeoutMs: number;
  /** Lets a shutdown signal abort an in-flight FFmpeg run. */
  signal?: AbortSignal;
}

export interface ProcessResult {
  /** Collected as bytes: ffmpeg writes the rendered image to stdout. */
  stdout: Buffer;
  stderr: string;
  /** Non-zero means the tool rejected the input; callers decide what that means. */
  exitCode: number | null;
}

const KILL_GRACE_MS = 5_000;

/**
 * Runs an external binary with an argv array.
 *
 * Arguments are never concatenated into a shell string, so a value derived from a
 * video cannot be interpreted as a command. Every run is bounded by a timeout:
 * first `SIGTERM` so FFmpeg can finalise, then `SIGKILL` if it does not exit.
 */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (
      outcome: { ok: true; value: ProcessResult } | { ok: false; error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);

      if (outcome.ok) {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }
    };

    const terminate = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    function onAbort(): void {
      terminate();
      finish({
        ok: false,
        error: new ProcessExecutionError(`${command} was aborted`),
      });
    }

    const timeoutTimer = setTimeout(() => {
      terminate();
      finish({
        ok: false,
        error: new ProcessExecutionError(
          `${command} timed out after ${options.timeoutMs}ms`,
        ),
      });
    }, options.timeoutMs);

    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        error: new ProcessExecutionError(
          `${command} could not be started: ${error.message}`,
        ),
      });
    });

    child.on('close', (code: number | null) => {
      finish({
        ok: true,
        value: {
          stdout: Buffer.concat(stdoutChunks),
          stderr,
          exitCode: code,
        },
      });
    });
  });
}
