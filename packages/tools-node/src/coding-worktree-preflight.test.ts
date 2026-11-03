import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
it.runIf(process.platform === 'linux').each(['preparing', 'ready', 'later'])(
  'preflights protected names in every selected tree before object/body traversal: %s',
  async (kind) => {
    const f = partialFixture('indexed');
    try {
      const inventory = f.inventory();
      let root = f.root;
      if (kind === 'ready') Object.assign(inventory.worktrees[0]!, { state: 'ready' });
      if (kind === 'later') {
        const id = 'later',
          slot = createHash('sha256')
            .update(JSON.stringify(['owner', f.project, id]))
            .digest('hex');
        root = join(f.managed, slot);
        const branch = 'codex/ocean/' + slot;
        f.git(
          f.project,
          'worktree',
          'add',
          '--no-checkout',
          '-b',
          branch,
          root,
          f.worktree.baseCommit,
        );
        fs.chmodSync(root, 0o700);
        f.git(root, 'read-tree', f.worktree.baseCommit);
        inventory.tasks.push({ ...inventory.tasks[0]!, id, worktreeRoot: root });
        inventory.worktrees.push({
          ...f.worktree,
          taskId: id,
          root,
          branch,
          lease: { ...f.worktree.lease, taskId: id, projectRoot: root },
        });
      }
      fs.writeFileSync(join(root, 'secret.key'), 'synthetic protected body');
      f.git(root, 'add', 'secret.key');
      fs.linkSync(join(root, 'secret.key'), join(root, 'earlier-alias'));
      const { hash: _old, ...body } = inventory;
      const frozen = {
        ...body,
        hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      };
      const actual = await vi.importActual<typeof childProcess>('node:child_process');
      const actualFs = await vi.importActual<typeof fs>('node:fs');
      let objectReads = 0,
        bodyReads = 0,
        consumed = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const path = actualFs.realpathSync('/proc/self/fd/' + args[0]);
        if (
          (path.startsWith(f.managed + '/') && !path.endsWith('/.git')) ||
          (path.startsWith(f.project + '/') && !path.startsWith(f.common + '/'))
        )
          bodyReads++;
        return actualFs.readSync(...args);
      }) as typeof fs.readSync);
      vi.mocked(childProcess.execFileSync).mockImplementation(((
        ...args: Parameters<typeof childProcess.execFileSync>
      ) => {
        if (args[1]?.some((arg) => ['rev-list', 'cat-file', 'pack-objects'].includes(arg)))
          objectReads++;
        return actual.execFileSync(...args);
      }) as typeof childProcess.execFileSync);
      try {
        await expect(
          captureCodingWorktreeAssets(
            frozen,
            f.managed,
            async () => {
              consumed++;
            },
            async () => {
              consumed++;
            },
          ),
        ).rejects.toThrow('protected_coding_asset');
        expect(objectReads).toBe(0);
        expect(bodyReads).toBe(0);
        expect(consumed).toBe(0);
      } finally {
        vi.mocked(childProcess.execFileSync).mockImplementation(actual.execFileSync);
        vi.mocked(fs.readSync).mockImplementation(actualFs.readSync);
      }
      expect(fs.readFileSync(join(root, 'secret.key'), 'utf8')).toBe('synthetic protected body');
      expect(fs.statSync(join(root, 'secret.key')).nlink).toBe(2);
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['preparing', 'ready'])(
  'repeats the protected metadata preflight before final object reads after the last %s consumer',
  async (state) => {
    const f = partialFixture('indexed'),
      actual = await vi.importActual<typeof childProcess>('node:child_process');
    try {
      Object.assign(f.worktree, { state });
      fs.mkdirSync(join(f.root, 'dir'));
      let objectReads = 0;
      vi.mocked(childProcess.execFileSync).mockImplementation(((
        ...args: Parameters<typeof childProcess.execFileSync>
      ) => {
        if (args[1]?.some((arg) => ['rev-list', 'cat-file', 'pack-objects'].includes(arg)))
          objectReads++;
        return actual.execFileSync(...args);
      }) as typeof childProcess.execFileSync);
      const consume = async () => {
        objectReads = 0;
        fs.writeFileSync(join(f.root, 'dir/secret.key'), 'protected');
      };
      await expect(
        captureCodingWorktreeAssets(f.inventory(), f.managed, consume, consume),
      ).rejects.toThrow('protected_coding_asset');
      expect(objectReads).toBe(0);
      expect(fs.readFileSync(join(f.root, 'dir/secret.key'), 'utf8')).toBe('protected');
    } finally {
      vi.mocked(childProcess.execFileSync).mockImplementation(actual.execFileSync);
      f.close();
    }
  },
);
