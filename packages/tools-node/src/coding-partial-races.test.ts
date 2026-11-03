import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
import { mapped } from '../test-fixtures/coding-partial-mapping.test.js';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { archivePartialCodingGit } from './coding-git-partial-archive.js';
function pair(f: ReturnType<typeof partialFixture>) {
  const inventory = f.inventory(),
    id = 'later';
  const slot = createHash('sha256')
    .update(JSON.stringify(['owner', f.project, id]))
    .digest('hex');
  const root = join(f.managed, slot),
    branch = 'codex/ocean/' + slot;
  f.git(f.project, 'worktree', 'add', '--no-checkout', '-b', branch, root, f.worktree.baseCommit);
  inventory.tasks.push({ ...inventory.tasks[0]!, id, worktreeRoot: root });
  inventory.worktrees.push({
    ...f.worktree,
    taskId: id,
    root,
    branch,
    lease: { ...f.worktree.lease, taskId: id, projectRoot: root },
  });
  const { hash: _old, ...body } = inventory;
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
it.runIf(process.platform === 'linux').each(['HEAD', 'index', 'branch', 'object', 'tree'])(
  'rechecks earlier %s bytes after the last consumer despite same-size stable-time mmap',
  async (kind) => {
    const f = partialFixture('indexed');
    try {
      const inventory = pair(f);
      const path =
        kind === 'branch'
          ? join(f.common, 'refs/heads', f.worktree.branch)
          : kind === 'object'
            ? join(
                f.common,
                'objects',
                f.worktree.baseCommit.slice(0, 2),
                f.worktree.baseCommit.slice(2),
              )
            : kind === 'tree'
              ? join(f.root, 'a')
              : join(f.admin, kind);
      if (kind === 'object') fs.chmodSync(path, 0o644);
      const bytes = fs.readFileSync(path);
      bytes[0] = bytes[0]! ^ 1;
      await mapped(path, bytes, async (mutate) => {
        await expect(
          captureCodingWorktreeAssets(
            inventory,
            f.managed,
            async () => {},
            async (input) => {
              if (input.worktree.taskId === 'later') await mutate();
            },
          ),
        ).rejects.toThrow(/stale_coding|coding_git_capture_failed/);
      });
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux')(
  'cannot archive consumer-mutated evidence under its original source handle',
  async () => {
    const f = partialFixture('indexed');
    try {
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async ({ git }) => {
          git.pack[0] = 0;
          expect(() => archivePartialCodingGit(git, join(f.outer, 'archive'))).toThrow(
            'stale_coding_git_storage',
          );
          expect(fs.existsSync(join(f.outer, 'archive'))).toBe(false);
        },
      );
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['initial', 'after-consumer'])(
  'rejects administrative file mount substitution %s',
  async (phase) => {
    const f = partialFixture('indexed'),
      actual = await vi.importActual<typeof fs>('node:fs');
    let changed = phase === 'initial',
      bodyReads = 0;
    vi.mocked(fs.readFileSync).mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const result = actual.readFileSync(...args),
        path = String(args[0]);
      if (
        changed &&
        path.startsWith('/proc/self/fdinfo/') &&
        typeof result === 'string' &&
        actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)) === join(f.admin, 'index')
      )
        return result.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999999');
      return result;
    }) as typeof fs.readFileSync);
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (changed && actual.realpathSync('/proc/self/fd/' + args[0]) === join(f.root, 'a'))
        bodyReads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    try {
      await expect(
        captureCodingWorktreeAssets(
          f.inventory(),
          f.managed,
          async () => {},
          async () => {
            changed = true;
          },
        ),
      ).rejects.toThrow(/coding_git_storage/);
      expect(bodyReads).toBe(0);
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
