import { spawn } from 'node:child_process';
import type { ToolResult } from '@runnets/application';

const OUTPUT_LIMIT = 32768;
/** Only the selected environment reaches commands; provider tokens are never inherited. */
export function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

/** Execute without a shell, bound output/time, kill the process group on abort, await close. */
export async function runCommand(
  program: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      cwd,
      env: commandEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    let output = '';
    let bytes = 0;
    let reason: string | null = null;
    let finished = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (cause: string): void => {
      reason ??= cause;
      cleanupTimer ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({
          isError: true,
          uncertain: true,
          output: `${output}\n${reason ?? 'interrupted'}; process cleanup unconfirmed`,
        });
      }, 1000);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = (): void => kill('cancelled');
    const timer = setTimeout(() => kill('command timed out after 60 seconds'), 60000);
    const finish = (result: ToolResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const capture = (chunk: Buffer): void => {
      const remaining = Math.max(0, OUTPUT_LIMIT - bytes);
      output += chunk.subarray(0, remaining).toString('utf8');
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) kill('output limit reached (32 KiB)');
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => {
      if (child.pid === undefined) finish({ isError: true, output: 'command could not start' });
      else kill('command process error; outcome unknown');
    });
    child.once('close', (code, exitSignal) => {
      // A child may leave background descendants; never deliberately leave that group running.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group is already gone */
        }
      }
      finish({
        isError: reason !== null || code !== 0,
        // Pipe closure and leader exit cannot prove escaped descendants stopped.
        uncertain: true,
        output: `${output}\n${reason ?? `exit code: ${String(code)}${exitSignal === null ? '' : ` (${exitSignal})`}`}`,
      });
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
