import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { openOceanProfile } from '../ocean/profile.js';

const run = promisify(execFile);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(condition: () => boolean, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('timeout: ' + label);
    await sleep(25);
  }
}
it.runIf(process.platform === 'linux')(
  'CLI broadcast submits, shows and refuses a vote on a settled batch without extra rounds',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-broadcast-cli-'));
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
    const runtime = openOceanProfile(profile, true);
    await runtime.ready;
    const execute = runtime.conversations.execute.bind(runtime.conversations);
    execute({
      type: 'BindWorkspace',
      requestId: 'init',
      workspaceId: 'ws_ocean',
      root: '/project',
    });
    const botIds = ['dev', 'review'].map((handle) => {
      const created = execute({
        type: 'CreateBot',
        workspaceId: 'ws_ocean',
        requestId: 'bot-' + handle,
        handle,
        name: handle,
        role: 'fixture',
        provider: 'deepseek',
        model: 'deepseek-flash',
      });
      if (!created.ok || created.value.kind !== 'bot') throw Error('bot');
      return created.value.data.id;
    });
    const room = execute({
      type: 'CreateGroupRoom',
      workspaceId: 'ws_ocean',
      requestId: 'team',
      title: 'Team',
      botIds,
    });
    runtime.close();
    if (!room.ok || room.value.kind !== 'room') throw Error('room');
    const roomId = room.value.data.id;
    const owner = spawn(
      process.execPath,
      [resolve('apps/cli/test-fixtures/broadcast-owner.test.ts'), profile, 'fast'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    owner.stdout.on('data', (b: Buffer) => (log += b.toString()));
    owner.stderr.on('data', (b: Buffer) => (log += b.toString()));
    const exit = once(owner, 'close') as Promise<[number | null, string | null]>;
    cleanups.push(async () => {
      if (owner.exitCode === null) owner.kill('SIGKILL');
      await exit;
    });
    await until(() => log.includes('ready'), 'owner ready');
    const cli = (words: string[]) =>
      run(
        process.execPath,
        [resolve('apps/cli/dist/main.js'), ...words, '--profile', profile, '--json'],
        { env },
      ).then(
        (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          code: error.code,
          out: error.stdout,
          err: error.stderr,
        }),
      );
    const submitted = await cli(['broadcast', roomId, '--text', 'Вопрос обоим участникам']);
    expect(submitted.code, submitted.out + submitted.err).toBe(0);
    const batch = JSON.parse(submitted.out).data as {
      id: string;
      state: string;
      recipients: { state: string; resultMessageId: string | null }[];
    };
    expect(batch.state).toBe('completed');
    expect(batch.recipients.map((child) => child.state)).toEqual(['answered', 'answered']);
    expect(batch.recipients.every((child) => child.resultMessageId !== null)).toBe(true);
    expect(readFileSync(join(profile, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
    const shown = await cli(['broadcast', 'show', roomId, batch.id]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out).data).toMatchObject({ id: batch.id, state: 'completed' });
    const vote = await cli(['broadcast', 'continue', roomId, batch.id, '--revision', '2']);
    expect(vote.code).toBe(2);
    expect(JSON.parse(vote.out)).toMatchObject({ ok: false, error: { code: 'batch_not_paused' } });
    const note = await cli(['send', roomId, '--text', 'Заметка без модели']);
    expect(note.code).toBe(0);
    expect(JSON.parse(note.out).data).toMatchObject({ turnId: null, runId: null });
    expect(readFileSync(join(profile, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
    const stopped = await cli(['runtime', 'stop']);
    expect(stopped.code).toBe(0);
    expect(await exit).toEqual([0, null]);
  },
  60_000,
);
