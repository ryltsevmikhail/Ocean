import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  CodingTaskService,
  CodingChangesetService,
  ConversationService,
} from '@runnets/application';
import {
  GitCodingProject,
  GitCodingWorktrees,
  GitCodingSnapshots,
  SqliteProjectLeases,
  createNativeBackend,
} from '@runnets/tools-node';
import { backupProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('persists a real worktree/full diff across reopen, holds legacy writers and refuses incomplete backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-worktree-integration-'));
  roots.push(root);
  const project = join(root, 'project'),
    profile = join(root, 'profile');
  mkdirSync(project);
  mkdirSync(profile, { mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', project, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  writeFileSync(join(project, 'file.txt'), 'original\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const path = join(profile, 'runtime.sqlite');
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  let store = openSqliteStore({ path });
  const leases = new SqliteProjectLeases(join(root, 'registry')),
    worktrees = new GitCodingWorktrees(join(root, 'worktrees'));
  const make = () => {
    const deps = {
      store: store.coding,
      leases,
      projects: new GitCodingProject(),
      journal: store.tools,
      ownerId: 'fixture',
      clock: { now: () => new Date() },
    };
    return {
      coding: new CodingTaskService(deps),
      changes: new CodingChangesetService({
        ...deps,
        worktrees,
        snapshots: new GitCodingSnapshots(),
      }),
    };
  };
  try {
    let id = 0;
    const c = new ConversationService({
      store: store.conversations,
      nextId: () => String(++id),
      clock: { now: () => new Date() },
    });
    const exec = (x: Record<string, unknown>) => {
      const result = c.execute({ workspaceId: 'ws', requestId: String(++id), ...x } as Parameters<
        typeof c.execute
      >[0]);
      if (!result.ok) throw Error('fixture');
      return result.value.data.id;
    };
    exec({ type: 'BindWorkspace', root: project });
    const dev = exec({
      type: 'CreateBot',
      handle: 'dev',
      name: 'Dev',
      role: 'Role',
      provider: 'test',
      model: 'test',
    });
    const review = exec({
      type: 'CreateBot',
      handle: 'review',
      name: 'Review',
      role: 'Role',
      provider: 'test',
      model: 'test',
    });
    const room = exec({ type: 'CreateGroupRoom', title: 'Team', botIds: [dev, review] });
    let service = make();
    expect(
      (
        await service.coding.start(
          {
            taskId: 'task',
            requestId: 'start',
            workspaceId: 'ws',
            projectRoot: project,
            ownerRoomId: room,
            devBotId: dev,
            reviewRoomId: room,
            reviewBotId: review,
            devCapabilities: ['project_read'],
            testPresets: [],
          },
          { confirm: async () => true },
        )
      ).ok,
    ).toBe(true);
    const access = {
      taskId: 'task',
      workspaceId: 'ws',
      roomId: room,
      botId: dev,
      policyVersion: 1,
      capability: 'project_read' as const,
    };
    const prepared = await service.changes.prepare(access, { confirm: async () => true });
    if (!prepared.ok) throw Error('worktree');
    writeFileSync(join(prepared.value.root, 'file.txt'), 'changed\n');
    writeFileSync(join(prepared.value.root, 'new.txt'), 'new\n');
    const captured = await service.changes.capture(access, 'capture');
    if (!captured.ok) throw Error('capture');
    expect(captured.value.files.map((f) => f.path)).toEqual(['file.txt', 'new.txt']);
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('original\n');
    expect(git('status', '--porcelain')).toBe('');
    const worker = await createNativeBackend(prepared.value.root, { leases });
    await expect(worker.write('file.txt', 'unauthorized', 'changed\n')).rejects.toThrow('reserved');
    store.close();
    store = openSqliteStore({ path });
    service = make();
    const reviewer = { ...access, botId: review, capability: 'changeset_read' as const };
    expect(service.changes.read(reviewer, captured.value.hash)).toEqual(captured);
    expect(
      (
        await service.changes.prepare(access, {
          confirm: async () => {
            throw Error('no repeated consent');
          },
        })
      ).ok,
    ).toBe(true);
    expect(await service.changes.capture(access, 'capture')).toEqual(captured);
    await expect(backupProfile(profile, join(root, 'incomplete-backup'))).rejects.toThrow(
      'coding_assets_unavailable',
    );
    expect(existsSync(join(root, 'incomplete-backup'))).toBe(false);
    expect(store.coding.atomic((tx) => tx.task('task'))?.worktreeRoot).toBe(prepared.value.root);
    renameSync(prepared.value.root, join(root, 'moved-worktree'));
    expect(await service.changes.prepare(access, { confirm: async () => true })).toMatchObject({
      ok: false,
      error: { code: 'recovery_required' },
    });
    expect(service.changes.read(reviewer, captured.value.hash)).toEqual(captured);
    expect(existsSync(prepared.value.root)).toBe(false);
  } finally {
    store.close();
  }
});
