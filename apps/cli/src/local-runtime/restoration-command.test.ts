import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { connectLocalRuntime, type LocalRuntimeClient } from '@runnets/tools-node';
import { startLocalRuntime, type LocalRuntimeHost } from './host.js';
import { runOceanCommand } from '../ocean/command.js';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
function cli(
  profile: string,
  args: string[],
  input?: PassThrough,
  error?: PassThrough,
): Promise<{ code: number; data: Record<string, unknown> }> {
  const output = new PassThrough();
  let text = '';
  output.on('data', (b: Buffer) => {
    text += b.toString();
  });
  return runOceanCommand(['rebind', ...args, '--profile', profile, '--json'], {
    output,
    error: error ?? new PassThrough(),
    ...(input ? { input } : {}),
  }).then((code) => ({ code, data: JSON.parse(text) as Record<string, unknown> }));
}
it('drives inspect, preview and TTY confirmation through the shared SDK without wire authority', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'restore-cli-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await codingWorkflowFixture('direct');
  cleanups.push(() => f.close());
  const selected = join(root, 'selected');
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  fs.writeFileSync(join(f.worktree, 'answer.txt'), 'cli restored marker\n');
  f.runtime.close();
  fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const task = readCodingBackupInventory(join(f.directory, 'runtime.sqlite')).tasks[0]!;
  fs.writeFileSync(
    join(f.directory, 'coding-projects.json'),
    JSON.stringify([
      { id: 'project', root: f.project, testPresets: task.policy.testPresets, mounts: [] },
    ]),
    { mode: 0o600 },
  );
  await backupProfile(f.directory, join(root, 'archive'), {
    managedDirectory: join(f.directory, 'worktrees'),
  });
  fs.rmSync(f.directory, { recursive: true });
  const profile = join(root, 'profile');
  restoreProfile(join(root, 'archive'), profile);
  fs.rmSync(join(root, 'archive'), { recursive: true });
  let host: LocalRuntimeHost | undefined = await startLocalRuntime({
    profile,
    restore: true,
    provider: null,
  });
  cleanups.push(async () => {
    if (!host) return;
    const stopped = await host.stop();
    if (stopped.outcome === 'complete') await host.closed;
    host = undefined;
  });
  const inspectInput = {
    requestId: 'cli-rebind',
    workspaceId: 'ws_ocean',
    roomId: f.room,
    taskId: task.id,
    projectRoot: selected,
    policy: task.policy,
  };
  const inspectConfig = join(root, 'inspect.json');
  fs.writeFileSync(inspectConfig, JSON.stringify(inspectInput), { mode: 0o600 });
  const inspected = await cli(profile, ['inspect', '--config', inspectConfig]);
  expect(inspected.code).toBe(0);
  const selection = (inspected.data['data'] as { selection: Record<string, unknown> }).selection;
  expect(selection).toMatchObject({ ...inspectInput, sourceOwnerId: task.ownerId });
  const selectionConfig = join(root, 'selection.json');
  fs.writeFileSync(selectionConfig, JSON.stringify(selection), { mode: 0o600 });
  const early = await cli(profile, ['result', '--config', selectionConfig]);
  expect(early.code).not.toBe(0);
  expect(early.data).toMatchObject({ ok: false, error: { code: 'rebind_request_conflict' } });
  const previewed = await cli(profile, ['preview', '--config', selectionConfig]);
  expect(previewed.code).toBe(0);
  const preview = previewed.data['data'] as {
    card: { decisionId: string; version: number; bindingDigest: string };
    preview: { selection: unknown };
  };
  expect(preview.preview.selection).toEqual(selection);
  const client: LocalRuntimeClient = await connectLocalRuntime({ profile });
  cleanups.push(() => client.close());
  expect(client.identity.capabilities).toEqual(
    expect.arrayContaining(['restore.maintenance', 'restore.preview']),
  );
  await expect(client.previewRestore({ ...selection, allow: true } as never)).rejects.toThrow(
    'invalid_params',
  );
  const input = new PassThrough();
  Object.defineProperty(input, 'isTTY', { value: true });
  input.write('y\n');
  const error = new PassThrough();
  Object.defineProperty(error, 'isTTY', { value: true });
  const confirmed = await cli(profile, ['confirm', '--config', selectionConfig], input, error);
  expect(confirmed.code).toBe(0);
  expect((confirmed.data['data'] as { status: string }).status).toBe('allowed');
  let result = (await cli(profile, ['result', '--config', selectionConfig])).data['data'] as {
    state: string;
    successorTaskId: string;
  };
  const deadline = Date.now() + 15000;
  while (!['ready', 'held', 'refused'].includes(result.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = (await cli(profile, ['result', '--config', selectionConfig])).data['data'] as {
      state: string;
      successorTaskId: string;
    };
  }
  expect(result.state).toBe('ready');
  expect(result.successorTaskId).toBeTruthy();
  expect(fs.existsSync(join(profile, 'restore-guard.json'))).toBe(true);
  const bad = await cli(profile, ['inspect', '--config', selectionConfig, '--text-only']);
  expect(bad.data).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
}, 120000);
