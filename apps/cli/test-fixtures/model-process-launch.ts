import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
export interface TimeoutReady {
  pids: number[];
  endpoint: string;
}
export function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}
/** Parent owns the scratch tree and isolated descendant group even if scenario JS cannot finish. */
export async function runModelScenario(
  scenario: string,
  options: { timeoutMs?: number; afterReady?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'oa-model-suite-'));
  const p = spawn(
    process.execPath,
    [fileURLToPath(new URL('model-process-scenario.test.ts', import.meta.url)), scenario, root],
    {
      detached: true,
      env: { NODE_NO_WARNINGS: '1', LANG: 'C.UTF-8', TMPDIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const pid = p.pid!;
  let stdout = '',
    stderr = '',
    ready: TimeoutReady | undefined,
    liveAtReady = false,
    exited = false;
  p.stdout!.on('data', (b: Buffer) => {
    stdout += b.toString();
  });
  p.stderr!.on('data', (b: Buffer) => {
    stderr += b.toString();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      p.once('error', reject);
      p.once('close', (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    },
  );
  let deadlineResolve!: () => void;
  const deadline = new Promise<void>((resolve) => {
    deadlineResolve = resolve;
  });
  let timer = setTimeout(
    deadlineResolve,
    options.afterReady ? 10000 : (options.timeoutMs ?? 90000),
  );
  p.on('message', (m: { ready?: TimeoutReady }) => {
    if (!m.ready) return;
    ready = m.ready;
    try {
      liveAtReady =
        ready.endpoint.startsWith(root + '/') &&
        ready.pids.every(processExists) &&
        statSync(ready.endpoint).isSocket();
    } catch {
      liveAtReady = false;
    }
    if (!liveAtReady) {
      deadlineResolve();
      return;
    }
    if (options.afterReady) {
      clearTimeout(timer);
      timer = setTimeout(deadlineResolve, options.timeoutMs ?? 100);
    }
  });
  const groupExists = () => processExists(-pid);
  const signalGroup = (signal: NodeJS.Signals) => {
    if (groupExists()) process.kill(-pid, signal);
  };
  async function waitForGone(ms: number, test: () => boolean) {
    const until = Date.now() + ms;
    while (test() && Date.now() < until) await sleep(10);
    return !test();
  }
  async function stop() {
    // Give the scenario a bounded opportunity to kill and reap its own children.
    if (!exited) p.kill('SIGTERM');
    await waitForGone(1000, () => !exited);
    if (groupExists()) {
      signalGroup('SIGTERM');
      await waitForGone(250, groupExists);
    }
    if (groupExists()) signalGroup('SIGKILL');
    if (!(await waitForGone(2000, () => !exited))) throw Error('scenario_exit_timeout');
    await closed;
    if (!(await waitForGone(2000, groupExists))) throw Error('scenario_group_cleanup_timeout');
  }
  try {
    const timedOut = await Promise.race([closed.then(() => false), deadline.then(() => true)]);
    await stop();
    const result = await closed;
    if (!timedOut && result.code !== 0) throw Error('model_scenario_failed:' + stderr);
    return { stdout, timedOut, root, pid, ready, liveAtReady, groupGone: !groupExists() };
  } finally {
    clearTimeout(timer);
    try {
      await stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
