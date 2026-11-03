import * as fs from 'node:fs';
import type * as NodeFs from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
import { indexRoots } from '../test-fixtures/coding-git-integrity.test.js';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { captureCodingGitObjects } from './coding-git-backup.js';
import { archivePartialCodingGit } from './coding-git-partial-archive.js';
it
  .runIf(process.platform === 'linux')
  .each(
    ['sha1', 'sha256'].flatMap((format) =>
      ['planned', 'ready'].flatMap((state) =>
        ['commit', 'blob'].map((object) => ({ format, state, object })),
      ),
    ),
  )(
  'refuses valid-zlib $object under a false OID in $format $state capture',
  async ({ format, state, object }) => {
    const f = partialFixture(state === 'planned' ? 'planned' : 'indexed', format);
    try {
      const oid =
        object === 'commit' ? f.worktree.baseCommit : f.git(f.project, 'rev-parse', 'HEAD:a');
      const path = join(f.common, 'objects', oid.slice(0, 2), oid.slice(2));
      const body = inflateSync(fs.readFileSync(path));
      body[body.length - 2] = body[body.length - 2]! ^ 1;
      fs.chmodSync(path, 0o644);
      fs.writeFileSync(path, deflateSync(body));
      const corrupt = fs.readFileSync(path),
        before = fs.statSync(path, { bigint: true });
      let consumed = false;
      if (state === 'ready') expect(() => captureCodingGitObjects(f.worktree)).toThrow();
      else
        await expect(
          captureCodingWorktreeAssets(
            f.inventory(),
            f.managed,
            async () => {},
            async ({ git }) => {
              consumed = true;
              archivePartialCodingGit(git, join(f.outer, 'archive'));
            },
          ),
        ).rejects.toThrow();
      expect(consumed).toBe(false);
      expect(fs.existsSync(join(f.outer, 'archive'))).toBe(false);
      expect(fs.readFileSync(path)).toEqual(corrupt);
      expect(fs.statSync(path, { bigint: true })).toMatchObject({
        ino: before.ino,
        mode: before.mode,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs,
      });
    } finally {
      f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'retains incomplete evidence if a source object becomes corrupt after archive creation',
  async () => {
    const f = partialFixture('planned'),
      archive = join(f.outer, 'archive');
    const actual = await vi.importActual<typeof NodeFs>('node:fs');
    const originalWrite = actual.writeFileSync;
    let changed = false;
    try {
      const oid = f.worktree.baseCommit,
        path = join(f.common, 'objects', oid.slice(0, 2), oid.slice(2));
      const body = inflateSync(fs.readFileSync(path));
      body[body.length - 2] = body[body.length - 2]! ^ 1;
      const corrupt = deflateSync(body);
      const spy = vi
        .mocked(fs.writeFileSync)
        .mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
          originalWrite(...args);
          if (
            typeof args[0] === 'number' &&
            fs.readlinkSync('/proc/self/fd/' + args[0]) === join(archive, 'pack')
          ) {
            changed = true;
            fs.chmodSync(path, 0o644);
            originalWrite(path, corrupt);
          }
        });
      await expect(
        captureCodingWorktreeAssets(
          f.inventory(),
          f.managed,
          async () => {},
          async ({ git }) => {
            archivePartialCodingGit(git, archive);
          },
        ),
      ).rejects.toThrow();
      spy.mockImplementation(originalWrite);
      expect(changed).toBe(true);
      expect(fs.existsSync(join(archive, 'incomplete'))).toBe(true);
      expect(fs.readFileSync(path)).toEqual(corrupt);
    } finally {
      vi.mocked(fs.writeFileSync).mockImplementation(originalWrite);
      f.close();
    }
  },
);

it
  .runIf(process.platform === 'linux')
  .each(
    ['sha1', 'sha256'].flatMap((format) => ['staged', 'reuc'].map((root) => ({ format, root }))),
  )(
  'refuses corrupt $format $root-only objects before consuming capture',
  async ({ format, root }) => {
    const f = partialFixture('indexed', format);
    try {
      const roots = indexRoots(f),
        oid = root === 'staged' ? roots.staged : roots.reuc,
        path = join(f.common, 'objects', oid.slice(0, 2), oid.slice(2));
      const body = inflateSync(fs.readFileSync(path));
      body[body.length - 1] = body[body.length - 1]! ^ 1;
      fs.chmodSync(path, 0o644);
      fs.writeFileSync(path, deflateSync(body));
      const corrupt = fs.readFileSync(path);
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
      ).rejects.toThrow();
      expect(consumed).toBe(false);
      expect(fs.readFileSync(path)).toEqual(corrupt);
    } finally {
      f.close();
    }
  },
);
