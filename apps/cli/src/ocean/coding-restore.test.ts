import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '@runnets/store-sqlite';
import { CodingTaskService, ConversationService } from '@runnets/application';
import { InMemoryProjectLeases } from '@runnets/store';
import { backupProfile, restoreProfile } from './snapshots.js';
import { createRuntime } from '../runtime.js';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-coding-restore-'));
  roots.push(root);
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const path = join(profile, 'runtime.sqlite');
  closeSync(openSync(path, 'wx', 0o600));
  return { root, profile, path };
}
it('backup keeps schema7 task/rights; restored runtime refuses all coding authority', async () => {
  const { root, profile, path } = temporary(),
    store = openSqliteStore({ path });
  let id = 0;
  const clock = { now: () => new Date() },
    leases = new InMemoryProjectLeases();
  const c = new ConversationService({
    store: store.conversations,
    clock,
    nextId: () => String(++id),
  });
  const execute = (request: Record<string, unknown>) => {
    const result = c.execute({
      workspaceId: 'ws',
      requestId: String(++id),
      ...request,
    } as Parameters<typeof c.execute>[0]);
    if (!result.ok) throw Error('fixture');
    return result.value.data.id;
  };
  execute({ type: 'BindWorkspace', root: '/project' });
  const dev = execute({
    type: 'CreateBot',
    handle: 'dev',
    name: 'Dev',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  const reviewer = execute({
    type: 'CreateBot',
    handle: 'review',
    name: 'Review',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  const room = execute({ type: 'CreateGroupRoom', title: 'Team', botIds: [dev, reviewer] });
  const service = new CodingTaskService({
    store: store.coding,
    leases,
    journal: store.tools,
    clock,
    ownerId: 'original',
    projects: {
      inspect: async () => ({ root: '/project', baseCommit: 'a'.repeat(40), clean: true }),
    },
  });
  const input = {
    taskId: 'task',
    requestId: 'start',
    workspaceId: 'ws',
    projectRoot: '/project',
    ownerRoomId: room,
    reviewRoomId: room,
    devBotId: dev,
    reviewBotId: reviewer,
    devCapabilities: ['project_read'] as const,
    testPresets: [],
  };
  const created = await service.start(input, { confirm: async () => true });
  expect(created.ok).toBe(true);
  store.close();
  const snapshot = join(root, 'backup'),
    restored = join(root, 'restored');
  expect((await backupProfile(profile, snapshot)).summary.schema).toBe(9);
  restoreProfile(snapshot, restored);
  const copy = openSqliteStore({ path: join(restored, 'runtime.sqlite') });
  expect(copy.coding.atomic((tx) => tx.task('task'))).toEqual(created.ok ? created.value : null);
  copy.close();
  const runtime = createRuntime({ dbPath: join(restored, 'runtime.sqlite'), restoredAccess: true });
  try {
    await runtime.ready;
    expect(
      runtime.coding.authorize({
        taskId: 'task',
        workspaceId: 'ws',
        roomId: room,
        botId: dev,
        policyVersion: 1,
        capability: 'project_read',
      }),
    ).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
    expect(
      await runtime.coding.start(input, {
        confirm: async () => {
          throw Error('must not ask');
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
  } finally {
    runtime.close();
  }
});
it('still backs up and restores a released schema5 snapshot without migrating the source', async () => {
  const { root, profile, path } = temporary(),
    db = new DatabaseSync(path);
  const fixture = new URL(
    '../../../../packages/store-sqlite/src/fixtures/ocean-schema-v5.sql',
    import.meta.url,
  );
  db.exec(readFileSync(fixture, 'utf8'));
  db.close();
  const backup = join(root, 'backup'),
    restored = join(root, 'restored');
  expect((await backupProfile(profile, backup)).summary.schema).toBe(5);
  restoreProfile(backup, restored);
  for (const file of [path, join(restored, 'runtime.sqlite')]) {
    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe(
      '5',
    );
    check.close();
  }
});
