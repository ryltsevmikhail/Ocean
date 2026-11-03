import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { CodingTask, CodingWorktree } from '@runnets/domain';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { snapshotCodingDatabase } from '@runnets/store-sqlite';
import { captureProfileBackupAssets } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('reserves two independent Git archive occurrences sharing one closure before any selected tree body', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-git-budget-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false),
    actual = await vi.importActual<typeof fs>('node:fs');
  const git = (cwd: string, args: string[], input?: string) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { input, encoding: 'utf8' }).trim();
  try {
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
    let second: string;
    try {
      const task = JSON.parse(
        String(db.prepare('SELECT payload FROM ocean_coding_tasks').get()!['payload']),
      ) as CodingTask;
      const tree = JSON.parse(
        String(db.prepare('SELECT payload FROM ocean_worktrees').get()!['payload']),
      ) as CodingWorktree;
      const id = 'second',
        slot = createHash('sha256')
          .update(JSON.stringify([task.lease.ownerId, f.project, id]))
          .digest('hex');
      second = join(f.directory, 'worktrees', slot);
      git(f.project, ['worktree', 'add', '-q', '-b', 'codex/ocean/' + slot, second, f.base]);
      fs.chmodSync(second, 0o700);
      const next = {
        ...task,
        status: 'cancelled' as const,
        id,
        worktreeRoot: second,
        lease: { ...task.lease, taskId: id },
      };
      const nextTree = {
        ...tree,
        taskId: id,
        root: second,
        branch: 'codex/ocean/' + slot,
        lease: { ...tree.lease, taskId: id, projectRoot: second },
      };
      db.prepare('INSERT INTO ocean_coding_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        id,
        next.workspaceId,
        next.projectRoot,
        next.ownerRoomId,
        next.devBotId,
        next.reviewRoomId,
        next.reviewBotId,
        next.status,
        next.policyVersion,
        JSON.stringify(next),
      );
      db.prepare('INSERT INTO ocean_worktrees VALUES(?,?,?,?)').run(
        id,
        second,
        'ready',
        JSON.stringify(nextTree),
      );
    } finally {
      db.close();
    }
    const object = git(f.worktree, ['hash-object', '-w', '--stdin'], 'x'.repeat(40000));
    for (const tree of [f.worktree, second!])
      git(tree, ['update-index', '--add', '--cacheinfo', '100644', object, 'index-only']);
    let bodies = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const path = actual.realpathSync('/proc/self/fd/' + args[0]);
      if (
        [
          join(f.worktree, 'math.cjs'),
          join(second!, 'math.cjs'),
          join(f.worktree, 'exact.txt'),
        ].includes(path)
      )
        bodies++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    const frozen = join(root, 'frozen.sqlite'),
      archive = join(root, 'assets');
    await expect(
      snapshotCodingDatabase(
        join(f.directory, 'runtime.sqlite'),
        frozen,
        async (inventory, desktop) =>
          captureProfileBackupAssets(
            {
              inventory,
              desktop,
              profile: f.directory,
              managed: join(f.directory, 'worktrees'),
              databaseBytes: fs.statSync(frozen).size,
            },
            archive,
            undefined,
            { logical: fs.statSync(frozen).size + 65000 },
          ),
      ),
    ).rejects.toThrow('profile_backup_limit');
    expect(bodies).toBe(0);
    expect(fs.existsSync(archive)).toBe(false);
  } finally {
    f.close();
  }
});
