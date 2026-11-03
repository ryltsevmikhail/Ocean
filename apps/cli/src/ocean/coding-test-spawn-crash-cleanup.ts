import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/** Host environment the sandbox supervisor itself uses for its transient user units. */
export const systemdEnv = {
  PATH: '/usr/bin:/bin',
  XDG_RUNTIME_DIR: '/run/user/' + process.getuid?.(),
};

/** The exact transient unit the worker reported (test-only observation line). */
export function observedUnit(out: string): string | undefined {
  const line = out
    .split('\n')
    .filter((entry) => entry.startsWith('unit '))
    .at(-1);
  return line?.slice(5);
}

/** Run one exact external stop of the observed unit (whole cgroup unless args narrow it). */
export function stopCgroup(unit: string, args: readonly string[]): void {
  execFileSync('/usr/bin/systemctl', ['--user', ...args, unit], {
    env: systemdEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
}

export function stopUnit(unit: string): void {
  try {
    stopCgroup(unit, ['stop']);
  } catch {
    /* Failure-path cleanup stays best-effort; a normal pass already stopped it. */
  }
}

/** Whether any host process still carries the unique preset token. */
export function running(token: string): boolean {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync('/proc/' + entry + '/cmdline', 'utf8').includes(token)) return true;
    } catch {
      /* process exited while scanning */
    }
  }
  return false;
}

interface WorkerHandle {
  readonly child: {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals): boolean;
  };
  readonly exit: Promise<[number | null, string | null]>;
}

/** Kill the worker and stop its observed unit so a fixture directory is never removed under it. */
export async function finishWorker(worker: WorkerHandle, unit: string | undefined): Promise<void> {
  if (unit !== undefined) stopUnit(unit);
  if (worker.child.exitCode === null && worker.child.signalCode === null)
    worker.child.kill('SIGKILL');
  await worker.exit;
}
