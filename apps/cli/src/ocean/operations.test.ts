import type { OceanCommandOptions } from './command.js';
import type { ModelRequest, ProviderPort } from '@runnets/application';
import { afterEach, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOceanCommand } from './command.js';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function call(profile: string, args: string[], options: OceanCommandOptions = {}) {
  let raw = '';
  const output = new PassThrough();
  output.on('data', (b: Buffer) => {
    raw += b.toString();
  });
  const code = await runOceanCommand([...args, '--profile', profile, '--json'], {
    output,
    error: new PassThrough(),
    ...options,
  });
  return { code, reply: JSON.parse(raw) };
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-ops-'));
  roots.push(root);
  const profile = join(root, 'profile');
  expect((await call(profile, ['init', '--workspace', root])).code).toBe(0);
  expect(
    (await call(profile, ['bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Role']))
      .code,
  ).toBe(0);
  const room = (await call(profile, ['room', 'direct', '--bot', 'dev'])).reply.data.data
    .id as string;
  return { root, profile, room };
}
it('backs up, restores and reads a private profile without enabling old or new dispatch', async () => {
  const { root, profile, room } = await setup();
  const copy = join(root, 'backup');
  const restored = join(root, 'restored');
  expect((await call(profile, ['doctor'])).reply.data.database.status).toBe('ok');
  expect((await call(profile, ['backup', '--to', copy])).code).toBe(0);
  expect((await call(restored, ['restore', '--from', copy])).code).toBe(0);
  expect(statSync(join(restored, 'runtime.sqlite')).mode & 0o777).toBe(0o600);
  expect((await call(restored, ['room', 'list'])).reply.data).toHaveLength(1);
  expect((await call(restored, ['send', room, '--text', 'new'])).reply.error.code).toBe(
    'restore_restricted',
  );
  expect(
    (await call(restored, ['send', room, '--text', 'new', '--text-only'])).reply.error.code,
  ).toBe('approval_required');
  expect((await call(restored, ['doctor'])).reply.data.restored).toBe(true);
  expect((await call(restored, ['restore', '--from', copy])).code).toBe(2);
});
it('rejects insecure permissions, symlinks and corrupted snapshots without overwriting', async () => {
  const { root, profile } = await setup();
  const copy = join(root, 'backup');
  chmodSync(profile, 0o755);
  expect((await call(profile, ['backup', '--to', copy])).reply.error.code).toBe(
    'insecure_permissions',
  );
  chmodSync(profile, 0o700);
  expect((await call(profile, ['backup', '--to', copy])).code).toBe(0);
  const bytes = readFileSync(join(copy, 'runtime.sqlite'));
  bytes[100] = (bytes[100] ?? 0) ^ 1;
  writeFileSync(join(copy, 'runtime.sqlite'), bytes);
  expect((await call(join(root, 'bad'), ['restore', '--from', copy])).reply.error.code).toBe(
    'invalid_backup',
  );
  const link = join(root, 'link');
  symlinkSync(profile, link);
  expect((await call(link, ['doctor'])).reply.data.permissions).toBe(false);
});

it('restored text requires fresh consent, preserves context and blocks legacy/TUI execution', async () => {
  const { root, profile, room } = await setup();
  const requests: ModelRequest[] = [];
  const provider: ProviderPort = {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'Saved answer' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  expect(
    (
      await call(profile, ['send', room, '--text', 'Remember', '--request-id', 'first'], {
        provider,
      })
    ).code,
  ).toBe(0);
  const doctor = await call(profile, ['doctor']);
  expect(doctor.reply.data.database.summary.unfinishedRuns).toBe(0);
  const copy = join(root, 'backup'),
    restored = join(root, 'restored');
  expect((await call(profile, ['backup', '--to', copy])).code).toBe(0);
  expect((await call(restored, ['restore', '--from', copy])).code).toBe(0);
  requests.length = 0;
  expect(
    (
      await call(restored, ['send', room, '--text', 'Repeat?', '--text-only'], {
        provider,
        restoredApproval: async () => false,
      })
    ).code,
  ).toBe(4);
  expect(requests).toHaveLength(0);
  expect(
    (
      await call(restored, ['send', room, '--text', 'Next?', '--text-only'], {
        provider,
        restoredApproval: async () => true,
      })
    ).code,
  ).toBe(0);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain('Saved answer');
  expect(requests[0]?.tools).toBeUndefined();
  const { createRuntime } = await import('../runtime.js');
  expect(() => createRuntime({ dbPath: join(restored, 'runtime.sqlite') })).toThrow(
    'restore_restricted',
  );
  const { runDirectTui } = await import('./tui.js');
  await expect(runDirectTui({ profile: restored, roomId: room, provider })).rejects.toThrow(
    'restore_restricted',
  );
});

it('failed backup never creates a missing source database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-empty-'));
  roots.push(root);
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const result = await call(profile, ['backup', '--to', join(root, 'copy')]);
  expect(result.code).toBe(2);
  expect(existsSync(join(profile, 'runtime.sqlite'))).toBe(false);
  expect((await call(profile, ['init', '--workspace', root])).code).toBe(0);
});

it('incomplete restore is diagnosed and cannot send even with trusted text consent', async () => {
  const { root, profile, room } = await setup(),
    copy = join(root, 'copy'),
    restored = join(root, 'restored');
  await call(profile, ['backup', '--to', copy]);
  await call(restored, ['restore', '--from', copy]);
  writeFileSync(join(restored, 'restore-guard.json'), JSON.stringify({ state: 'restoring' }), {
    mode: 0o600,
  });
  const doctor = await call(restored, ['doctor']);
  expect(doctor.code).toBe(3);
  expect(doctor.reply.data.restorationState).toBe('incomplete');
  expect(
    (
      await call(restored, ['send', room, '--text', 'No', '--text-only'], {
        restoredApproval: async () => true,
      })
    ).reply.error.code,
  ).toBe('recovery_required');
});
