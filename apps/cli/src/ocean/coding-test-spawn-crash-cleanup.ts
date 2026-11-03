import { execFileSync } from 'node:child_process';

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

export function stopUnit(unit: string): void {
  try {
    execFileSync('/usr/bin/systemctl', ['--user', 'stop', unit], {
      env: systemdEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
  } catch {
    /* Failure-path cleanup stays best-effort; a normal pass already stopped it. */
  }
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
