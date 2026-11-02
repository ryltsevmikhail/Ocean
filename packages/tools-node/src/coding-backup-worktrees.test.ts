import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodingBackupInventory, CodingWorktree } from '@runnets/domain';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./coding-git-backup.js', async (original) => {
  const actual = await original<{ captureCodingGitObjects: typeof captureCodingGitObjects }>();
  return { ...actual, captureCodingGitObjects: vi.fn(actual.captureCodingGitObjects) };
});
import { captureCodingGitObjects } from './coding-git-backup.js';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup(count = 1) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-backup-graph-'));
  roots.push(outer);
  const project = join(outer, 'project'),
    managed = join(outer, 'managed');
  fs.mkdirSync(project);
  fs.mkdirSync(managed, { mode: 0o700 });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(project, 'init', '-q');
  fs.writeFileSync(join(project, 'file'), 'base');
  git(project, 'add', '.');
  git(
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  const baseCommit = git(project, 'rev-parse', 'HEAD');
  const tasks: CodingBackupInventory['tasks'][number][] = [],
    worktrees: CodingWorktree[] = [];
  for (let index = 0; index < count; index++) {
    const id = 'task' + index,
      slot = createHash('sha256')
        .update(JSON.stringify(['owner', project, id]))
        .digest('hex');
    const root = join(managed, slot),
      branch = 'codex/ocean/' + slot;
    git(project, 'worktree', 'add', '-qb', branch, root);
    fs.chmodSync(root, 0o700);
    tasks.push({
      id,
      workspaceId: 'ws',
      projectRoot: project,
      baseCommit,
      worktreeRoot: root,
      ownerId: 'owner',
      status: 'reserved',
    });
    worktrees.push({
      taskId: id,
      workspaceId: 'ws',
      projectRoot: project,
      baseCommit,
      root,
      branch,
      gitCommonDir: join(project, '.git'),
      state: 'ready',
      lease: {
        ownerId: 'owner',
        projectRoot: root,
        taskId: id,
        kind: 'coding',
        token: 'token',
        requestId: 'prepare',
        binding: 'binding',
      },
    });
  }
  const body = { format: 1 as const, tasks, worktrees, changesets: [], applications: [] };
  const inventory = {
    ...body,
    hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  return { outer, managed, project, inventory, git };
}
it.runIf(process.platform === 'linux')(
  'captures every bound worktree and index pack, preserving source bytes and unrelated checkout',
  async () => {
    const s = setup(2),
      seen: string[] = [];
    fs.writeFileSync(join(s.inventory.worktrees[0]!.root, 'file'), 'working');
    fs.writeFileSync(join(s.project, 'user'), 'keep');
    const result = await captureCodingWorktreeAssets(
      s.inventory,
      s.managed,
      async ({ slot, capture, git, worktree }) => {
        expect(capture.policy).toBe('coding-worktree');
        expect(git.baseCommit).toBe(worktree.baseCommit);
        archiveCodingAssetTree(capture, join(s.outer, slot));
        seen.push(worktree.taskId);
      },
    );
    expect(seen).toEqual(['task0', 'task1']);
    expect(result.worktrees).toHaveLength(2);
    for (const record of result.worktrees) {
      expect(record.presence).toBe('captured');
      if (record.presence === 'captured')
        expect(verifyCodingAssetArchive(join(s.outer, record.slot)).hash).toBe(record.treeHash);
    }
    expect(fs.readFileSync(join(s.project, 'user'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(join(s.inventory.worktrees[0]!.root, 'file'), 'utf8')).toBe('working');
  },
);
it.runIf(process.platform === 'linux')(
  'refuses a lost ready root, forged plan and mutation of an earlier captured root',
  async () => {
    const s = setup(2),
      first = s.inventory.worktrees[0]!;
    fs.rmSync(first.root, { recursive: true });
    await expect(
      captureCodingWorktreeAssets(s.inventory, s.managed, async () => {}),
    ).rejects.toThrow('missing_coding_worktree');
    const forged = structuredClone(s.inventory);
    Object.assign(forged.worktrees[1]!, { root: s.project });
    await expect(captureCodingWorktreeAssets(forged, s.managed, async () => {})).rejects.toThrow();
    const fresh = setup(2);
    await expect(
      captureCodingWorktreeAssets(fresh.inventory, fresh.managed, async ({ worktree }) => {
        if (worktree.taskId === 'task1')
          fs.writeFileSync(join(fresh.inventory.worktrees[0]!.root, 'file'), 'user');
      }),
    ).rejects.toThrow('stale_coding_asset');
    expect(fs.readFileSync(join(fresh.inventory.worktrees[0]!.root, 'file'), 'utf8')).toBe('user');
  },
);

it.runIf(process.platform === 'linux')(
  'records absent preparing roots without creating them, including an absent managed directory',
  async () => {
    const s = setup();
    const input = structuredClone(s.inventory);
    Object.assign(input.worktrees[0]!, { state: 'preparing' });
    const { hash: _old, ...body } = input;
    const inventory = {
      ...body,
      hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    };
    fs.rmSync(s.managed, { recursive: true });
    let called = false;
    const result = await captureCodingWorktreeAssets(inventory, s.managed, async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.worktrees[0]?.presence).toBe('absent');
    expect(result.worktrees[0]?.state).toBe('preparing');
    expect(fs.existsSync(s.managed)).toBe(false);
  },
);

it.runIf(process.platform === 'linux')(
  'bounds aggregate uncompressed Git objects before consuming another worktree',
  async () => {
    const s = setup(2),
      actual = await vi.importActual<{ captureCodingGitObjects: typeof captureCodingGitObjects }>(
        './coding-git-backup.js',
      );
    let consumed = 0;
    vi.mocked(captureCodingGitObjects).mockImplementation((binding) => ({
      ...actual.captureCodingGitObjects(binding),
      objectBytes: 1200000000,
    }));
    try {
      await expect(
        captureCodingWorktreeAssets(s.inventory, s.managed, async () => {
          consumed++;
        }),
      ).rejects.toThrow('coding_asset_limit');
      expect(consumed).toBe(1);
    } finally {
      vi.mocked(captureCodingGitObjects).mockImplementation(actual.captureCodingGitObjects);
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses a previously absent root that appears while another task is copied',
  async () => {
    const s = setup(2),
      input = structuredClone(s.inventory);
    Object.assign(input.worktrees[0]!, { state: 'uncertain' });
    const { hash: _old, ...body } = input;
    const inventory = {
      ...body,
      hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    };
    const missing = inventory.worktrees[0]!.root;
    fs.rmSync(missing, { recursive: true });
    await expect(
      captureCodingWorktreeAssets(inventory, s.managed, async () => {
        fs.mkdirSync(missing, { mode: 0o700 });
        fs.writeFileSync(join(missing, 'user'), 'keep');
      }),
    ).rejects.toThrow('stale_coding_asset');
    expect(fs.readFileSync(join(missing, 'user'), 'utf8')).toBe('keep');
  },
);
it.runIf(process.platform === 'linux')(
  'rechecks earlier index contents independently of unchanged working-tree bytes',
  async () => {
    const s = setup(2),
      first = s.inventory.worktrees[0]!;
    await expect(
      captureCodingWorktreeAssets(s.inventory, s.managed, async ({ worktree }) => {
        if (worktree.taskId !== 'task1') return;
        const blob = execFileSync(
          '/usr/bin/git',
          ['-C', first.root, 'hash-object', '-w', '--stdin'],
          { input: 'new staged content', encoding: 'utf8' },
        ).trim();
        s.git(first.root, 'update-index', '--cacheinfo', '100644,' + blob + ',file');
      }),
    ).rejects.toThrow('stale_coding_asset');
    expect(fs.readFileSync(join(first.root, 'file'), 'utf8')).toBe('base');
  },
);
