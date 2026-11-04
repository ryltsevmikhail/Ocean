import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { openOceanProfile } from '../ocean/profile.js';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const workspaceId = 'ws_ocean';
async function until(
  condition: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw Error('timeout: ' + label);
    await sleep(25);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-broadcast-crash-'));
  const profile = join(root, 'profile');
  const runtimeDir = join(root, 'run');
  mkdirSync(runtimeDir, { mode: 0o700 });
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
    XDG_RUNTIME_DIR: runtimeDir,
  };
  vi.stubEnv('XDG_RUNTIME_DIR', runtimeDir);
  cleanups.push(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const launch = (scenario: string) => {
    const child = spawn(
      process.execPath,
      [resolve('apps/cli/test-fixtures/broadcast-owner.test.ts'), profile, scenario],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    child.stdout.on('data', (b: Buffer) => (log += b.toString()));
    child.stderr.on('data', (b: Buffer) => (log += b.toString()));
    const exit = once(child, 'close') as Promise<[number | null, string | null]>;
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    });
    return {
      child,
      exit,
      ready: () => until(() => log.includes('ready'), 'owner ready', 15_000).then(() => undefined),
      log: () => log,
    };
  };
  return { root, profile, launch };
}
async function prepare(profile: string) {
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const execute = runtime.conversations.execute.bind(runtime.conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId, root: '/project' });
  for (const handle of ['dev', 'review']) {
    execute({
      type: 'CreateBot',
      workspaceId,
      requestId: 'bot-' + handle,
      handle,
      name: handle,
      role: 'fixture',
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
  }
  const bots = runtime.conversations.bots(workspaceId);
  if (!bots.ok) throw Error('bots');
  const room = execute({
    type: 'CreateGroupRoom',
    workspaceId,
    requestId: 'team',
    title: 'Team',
    botIds: bots.value.map((bot) => bot.id),
  });
  runtime.close();
  if (!room.ok || room.value.kind !== 'room') throw Error('room');
  return room.value.data.id;
}
it.runIf(process.platform === 'linux')(
  'kills the owner after the first answer and never redispatches started or completed children',
  async () => {
    const f = fixture();
    const roomId = await prepare(f.profile);
    const peer = decisionPeer(f.profile, join(f.root, 'run'));
    let owner = f.launch('hold-second');
    await owner.ready();
    const submitted = (await peer('broadcastSubmit', {
      workspaceId,
      roomId,
      requestId: 'broadcast-1',
      text: 'Вопрос обоим',
    })) as { id: string };
    let batch = await peer('broadcastGet', { workspaceId, roomId, batchId: submitted.id });
    await until(
      () => batch.recipients[0]?.state === 'answered' && batch.recipients[1]?.state === 'running',
      'first answered and second running',
    );
    // Two independent clients observe the same durable per-child states.
    const secondPeer = decisionPeer(f.profile, join(f.root, 'run'));
    expect(
      await secondPeer('broadcastGet', { workspaceId, roomId, batchId: submitted.id }),
    ).toEqual(batch);
    expect(readFileSync(join(f.profile, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
    owner.child.kill('SIGKILL');
    expect(await owner.exit).toEqual([null, 'SIGKILL']);
    owner = f.launch('successor');
    await owner.ready();
    batch = await peer('broadcastGet', { workspaceId, roomId, batchId: submitted.id });
    expect(batch).toMatchObject({ state: 'paused', revision: 2 });
    expect(batch.recipients.map((child: { state: string }) => child.state)).toEqual([
      'answered',
      'uncertain',
    ]);
    // No redispatch of the started child, even with a provider that would fail loudly.
    await sleep(300);
    expect(readFileSync(join(f.profile, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
    await expect(
      peer('broadcastContinue', {
        workspaceId,
        roomId,
        batchId: submitted.id,
        expectedRevision: 2,
      }),
    ).rejects.toThrow(/batch_uncertain/);
    await expect(
      peer('submit', { workspaceId, roomId, requestId: 'blocked', text: 'Новый', to: 'dev' }),
    ).rejects.toThrow(/batch_open/);
    const abandoned = (await peer('broadcastAbandon', {
      workspaceId,
      roomId,
      batchId: submitted.id,
      expectedRevision: 2,
    })) as { state: string; revision: number; recipients: { state: string }[] };
    expect(abandoned).toMatchObject({ state: 'abandoned', revision: 3 });
    expect(abandoned.recipients.map((child) => child.state)).toEqual(['answered', 'uncertain']);
    expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
    expect(await owner.exit).toEqual([0, null]);
  },
  45_000,
);
it.runIf(process.platform === 'linux')(
  'kills the owner while the first child is in flight; abandon leaves it uncertain and held siblings not started',
  async () => {
    const f = fixture();
    const roomId = await prepare(f.profile);
    const peer = decisionPeer(f.profile, join(f.root, 'run'));
    let owner = f.launch('hold-first');
    await owner.ready();
    const submitted = (await peer('broadcastSubmit', {
      workspaceId,
      roomId,
      requestId: 'broadcast-2',
      text: 'Вопрос обоим',
    })) as { id: string };
    await until(
      async () =>
        (
          (await peer('broadcastGet', { workspaceId, roomId, batchId: submitted.id })) as {
            recipients: { state: string }[];
          }
        ).recipients[0]?.state === 'running',
      'first child in flight',
    );
    owner.child.kill('SIGKILL');
    expect(await owner.exit).toEqual([null, 'SIGKILL']);
    owner = f.launch('successor');
    await owner.ready();
    const batch = (await peer('broadcastGet', {
      workspaceId,
      roomId,
      batchId: submitted.id,
    })) as { state: string; revision: number; recipients: { state: string }[] };
    expect(batch).toMatchObject({ state: 'paused', revision: 2 });
    expect(batch.recipients.map((child) => child.state)).toEqual(['uncertain', 'queued']);
    await expect(
      peer('broadcastContinue', {
        workspaceId,
        roomId,
        batchId: submitted.id,
        expectedRevision: 2,
      }),
    ).rejects.toThrow(/batch_uncertain/);
    const abandoned = (await peer('broadcastAbandon', {
      workspaceId,
      roomId,
      batchId: submitted.id,
      expectedRevision: 2,
    })) as { state: string; revision: number; recipients: { state: string }[] };
    expect(abandoned).toMatchObject({ state: 'abandoned' });
    expect(abandoned.recipients.map((child) => child.state)).toEqual(['uncertain', 'not_started']);
    expect(readFileSync(join(f.profile, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
    expect(await owner.exit).toEqual([0, null]);
  },
  45_000,
);
