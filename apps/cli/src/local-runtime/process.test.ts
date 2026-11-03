import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openOceanProfile } from '../ocean/profile.js';
import { localRuntimePaths } from '@runnets/tools-node';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-rt-process-'));
  const profile = join(root, 'profile'),
    runtimeRoot = join(root, 'run');
  mkdirSync(runtimeRoot, { mode: 0o700 });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(
      [
        'HOME',
        'XDG_RUNTIME_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'TMPDIR',
      ].map((key) => [key, process.env[key]]),
    ),
    PATH: process.env['PATH'],
    XDG_RUNTIME_DIR: runtimeRoot,
  };
  const launch = (args: string[], program?: string) => {
    const child = spawn(
      process.execPath,
      program
        ? ['--input-type=module', '-e', program, profile]
        : [resolve('apps/cli/dist/main.js'), 'runtime', ...args, '--profile', profile, '--json'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    });
    const ready = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('process readiness timeout: ' + stderr)), 5000);
        const read = () => {
          if (!stdout.includes('\n')) return;
          clearTimeout(timer);
          child.stdout.off('data', read);
          resolve(JSON.parse(stdout.split('\n')[0]!));
        };
        child.stdout.on('data', read);
        read();
        void exit.then(() => {
          clearTimeout(timer);
          if (!stdout.includes('\n')) reject(Error('exited before ready: ' + stderr));
        });
      });
    return { child, exit, ready, output: () => stdout };
  };
  return { root, profile, runtimeRoot, launch };
}
async function initialize(profile: string) {
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  runtime.close();
}
it.runIf(process.platform === 'linux')(
  'foreground owner survives detached status clients, refuses a second owner and stops by authenticated command',
  async () => {
    const f = fixture();
    await initialize(f.profile);
    const owner = f.launch(['start']);
    const ready = await owner.ready();
    const first = f.launch(['status']),
      second = f.launch(['status']);
    expect(await first.exit).toBe(0);
    expect(await second.exit).toBe(0);
    const data = JSON.parse(first.output()).data;
    expect(data.state).toBe('ready');
    expect(JSON.parse(second.output()).data.instanceId).toBe(data.instanceId);
    expect(ready).toMatchObject({ data: { instanceId: data.instanceId } });
    const concurrent = f.launch(['start']);
    expect(await concurrent.exit).toBe(3);
    expect(JSON.parse(concurrent.output())).toMatchObject({ error: { code: 'owner_busy' } });
    expect(owner.child.exitCode).toBeNull();
    const stop = f.launch(['stop']);
    expect(await stop.exit).toBe(0);
    expect(JSON.parse(stop.output())).toMatchObject({
      data: { state: 'stopped', outcome: 'complete' },
    });
    expect(await owner.exit).toBe(0);
    const restart = f.launch(['start']);
    expect(await restart.ready()).toMatchObject({ data: { state: 'ready' } });
    restart.child.kill('SIGTERM');
    expect(await restart.exit).toBe(0);
  },
  15000,
);
it.runIf(process.platform === 'linux')(
  'publishes readiness after uncertain-effect recovery and restarts the same profile after SIGKILL',
  async () => {
    const f = fixture();
    const runtime = openOceanProfile(f.profile, true);
    await runtime.ready;
    expect(
      await runtime.toolJournal!.claim(
        'effect',
        'synthetic',
        { taskRunId: 'tr_lost', attemptId: 'at_lost' },
        'fixed',
      ),
    ).toBe(true);
    runtime.close();
    const owner = f.launch(['start']);
    await owner.ready();
    const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT outcome FROM tool_invocations_v2 WHERE id='effect'").get(),
      ).toMatchObject({ outcome: 'uncertain' });
    } finally {
      db.close();
    }
    owner.child.kill('SIGKILL');
    await owner.exit;
    const status = f.launch(['status']);
    expect(await status.exit).toBe(3);
    expect(JSON.parse(status.output())).toMatchObject({ error: { code: 'runtime_unreachable' } });
    const restart = f.launch(['start']);
    expect(await restart.ready()).toMatchObject({ data: { state: 'ready' } });
    expect(await f.launch(['stop']).exit).toBe(0);
    expect(await restart.exit).toBe(0);
  },
  15000,
);
it.runIf(process.platform === 'linux').each([
  { drain: "async () => 'uncertain'", reason: 'uncertain' },
  { drain: "async () => { throw Error('drain failed'); }", reason: 'rejected' },
  { drain: '() => new Promise(() => {})', reason: 'deadline' },
])(
  'keeps ownership and reports uncertainty when the host drain is $reason',
  async ({ drain }) => {
    const f = fixture();
    await initialize(f.profile);
    const program = `import { startLocalRuntime } from './apps/cli/dist/local-runtime/host.js';
    const host = await startLocalRuntime({ profile: process.argv[1], provider: null, drain: ${drain}, drainDeadlineMs: 10 });
    console.log(JSON.stringify({ data: host.status() })); await host.closed;`;
    const owner = f.launch([], program);
    await owner.ready();
    const stop = f.launch(['stop']);
    expect(await stop.exit).toBe(4);
    expect(JSON.parse(stop.output())).toMatchObject({
      data: { state: 'stop_incomplete', outcome: 'uncertain' },
    });
    const status = f.launch(['status']);
    expect(await status.exit).toBe(0);
    expect(JSON.parse(status.output())).toMatchObject({ data: { state: 'stop_incomplete' } });
    const concurrent = f.launch(['start']);
    expect(await concurrent.exit).toBe(3);
    expect(owner.child.exitCode).toBeNull();
  },
  15000,
);
it.runIf(process.platform === 'linux')(
  'preserves a foreign socket replacement by refusing runtime close',
  async () => {
    const f = fixture();
    await initialize(f.profile);
    const owner = f.launch(['start']);
    await owner.ready();
    // Compute only the test-owned endpoint using the isolated runtime directory.
    const base = localRuntimePaths(f.profile);
    const socket = join(f.runtimeRoot, 'ocean-' + base.profileId.slice(0, 24), 'runtime.sock');
    rmSync(socket);
    writeFileSync(socket, 'foreign', { mode: 0o600 });
    owner.child.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('missing incomplete stop')), 5000);
      const read = () => {
        if (owner.output().includes('stop_incomplete')) {
          clearTimeout(timer);
          owner.child.stdout.off('data', read);
          resolve();
        }
      };
      owner.child.stdout.on('data', read);
      read();
    });
    expect(existsSync(socket)).toBe(true);
    expect(readFileSync(socket, 'utf8')).toBe('foreign');
    expect(owner.child.exitCode).toBeNull();
  },
  15000,
);
it.runIf(process.platform === 'linux')(
  'only one simultaneous ordinary restart can retire a predecessor',
  async () => {
    const f = fixture();
    await initialize(f.profile);
    const first = f.launch(['start']);
    await first.ready();
    first.child.kill('SIGKILL');
    await first.exit;
    const a = f.launch(['start']),
      b = f.launch(['start']);
    const results = await Promise.all([a.ready(), b.ready()]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ state: 'ready' }) }),
        expect.objectContaining({ error: expect.objectContaining({ code: 'owner_busy' }) }),
      ]),
    );
    expect(await f.launch(['stop']).exit).toBe(0);
    expect((await Promise.all([a.exit, b.exit])).sort()).toEqual([0, 3]);
  },
  15000,
);
