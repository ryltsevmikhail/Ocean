import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
const capture = (f: ReturnType<typeof partialFixture>) =>
  captureCodingWorktreeAssets(
    f.inventory(),
    f.managed,
    async () => {},
    async () => {},
  );
it
  .runIf(process.platform === 'linux')
  .each([
    'head',
    'backpointer',
    'lock',
    'alias',
    'fifo',
    'admin-symlink',
    'objects-symlink',
    'reflog-alias',
    'branch-lock',
    'reftable',
  ])(
  'refuses %s before task or original checkout bodies and preserves the namespace',
  async (kind) => {
    const f = partialFixture('partial');
    const canary = join(f.outer, 'secret.key');
    fs.writeFileSync(canary, 'synthetic secret');
    try {
      if (kind === 'branch-lock')
        fs.writeFileSync(join(f.common, 'refs/heads', f.worktree.branch + '.lock'), 'unfinished');
      if (kind === 'reftable') fs.mkdirSync(join(f.common, 'reftable'));
      if (kind === 'head') fs.writeFileSync(join(f.admin, 'HEAD'), 'ref: refs/heads/foreign\n');
      if (kind === 'backpointer')
        fs.writeFileSync(join(f.admin, 'gitdir'), join(f.project, '.git') + '\n');
      if (kind === 'lock') fs.writeFileSync(join(f.admin, 'index.lock'), 'partial index');
      if (kind === 'alias' || kind === 'fifo') {
        fs.unlinkSync(join(f.admin, 'HEAD'));
        if (kind === 'alias') fs.linkSync(canary, join(f.admin, 'HEAD'));
        else execFileSync('/usr/bin/mkfifo', [join(f.admin, 'HEAD')]);
      }
      if (kind === 'reflog-alias') {
        fs.unlinkSync(join(f.admin, 'logs/HEAD'));
        fs.symlinkSync(canary, join(f.admin, 'logs/HEAD'));
      }
      if (kind === 'admin-symlink') {
        fs.renameSync(f.admin, f.admin + '.saved');
        fs.symlinkSync(f.admin + '.saved', f.admin);
      }
      if (kind === 'objects-symlink') {
        fs.renameSync(join(f.common, 'objects'), join(f.common, 'saved'));
        fs.symlinkSync(join(f.common, 'saved'), join(f.common, 'objects'));
      }
      const before = fs.lstatSync(f.root, { bigint: true });
      const actual = await vi.importActual<typeof fs>('node:fs');
      let reads = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const path = actual.readlinkSync('/proc/self/fd/' + String(args[0]));
        if ([join(f.root, 'a'), join(f.project, 'a'), canary].includes(path)) reads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      try {
        await expect(capture(f)).rejects.toThrow();
        expect(reads).toBe(0);
      } finally {
        vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      }
      expect(fs.lstatSync(f.root, { bigint: true })).toMatchObject({
        ino: before.ino,
        mode: before.mode,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs,
      });
      expect(fs.readFileSync(canary, 'utf8')).toBe('synthetic secret');
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['index', 'branch', 'admin', 'root'])(
  'invalidates a newly appearing %s after the last consumer',
  async (kind) => {
    const f = partialFixture(kind === 'index' ? 'partial' : 'planned');
    try {
      await expect(
        captureCodingWorktreeAssets(
          f.inventory(),
          f.managed,
          async () => {},
          async () => {
            if (kind === 'index') f.git(f.root, 'read-tree', f.worktree.baseCommit);
            if (kind === 'branch')
              f.git(f.project, 'branch', f.worktree.branch, f.worktree.baseCommit);
            if (kind === 'admin')
              fs.mkdirSync(join(f.common, 'worktrees', f.slot), { recursive: true });
            if (kind === 'root') fs.mkdirSync(f.root);
          },
        ),
      ).rejects.toThrow(/stale_coding/);
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux')(
  'keeps private expected hashes despite consumer DTO mutation',
  async () => {
    const f = partialFixture('indexed');
    try {
      await expect(
        captureCodingWorktreeAssets(
          f.inventory(),
          f.managed,
          async () => {},
          async (input) => {
            const bytes = fs.readFileSync(join(f.admin, 'HEAD'));
            bytes[bytes.length - 2] = 98;
            fs.writeFileSync(join(f.admin, 'HEAD'), bytes);
            Object.assign(input.git.administration, { hash: 'forged', files: [] });
            Object.assign(input.git, { indexSha256: null, packSha256: 'forged' });
            Object.assign(input.capture!, {
              sourceStateHash: 'forged',
              limits: { bytes: 0, entries: 0, depth: 0 },
            });
          },
        ),
      ).rejects.toThrow(/stale_coding/);
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses malformed packed-ref storage instead of asserting branch absence',
  async () => {
    const f = partialFixture('planned');
    try {
      fs.writeFileSync(join(f.common, 'packed-refs'), 'not-a-native-packed-reference\n');
      let consumed = false;
      await expect(
        captureCodingWorktreeAssets(
          f.inventory(),
          f.managed,
          async () => {},
          async () => {
            consumed = true;
          },
        ),
      ).rejects.toThrow('unsupported_coding_git_storage');
      expect(consumed).toBe(false);
    } finally {
      f.close();
    }
  },
);
