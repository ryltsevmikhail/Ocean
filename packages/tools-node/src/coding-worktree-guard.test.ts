import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type * as GitModule from './coding-git.js';
import type * as Files from './coding-file.js';
import type * as Fs from 'node:fs/promises';
import { GitCodingSnapshots } from './coding-snapshot.js';
import { codingWorktreeFixture } from '../test-fixtures/coding-worktree.js';
const reads = vi.hoisted(() => ({
  enabled: false,
  allowed: true,
  git: [] as string[],
  afterLossGit: 0,
  afterLossPaths: 0,
  onGit: (_root: string, _args: readonly string[]) => {},
  onFile: (_path: string) => {},
}));
vi.mock('./coding-git.js', async (original) => {
  const actual = await original<typeof GitModule>();
  return {
    ...actual,
    codingGit: async (...args: Parameters<typeof actual.codingGit>) => {
      const result = await actual.codingGit(...args);
      if (reads.enabled) {
        reads.git.push(args[1].join(' '));
        if (!reads.allowed) reads.afterLossGit++;
        reads.onGit(args[0], args[1]);
      }
      return result;
    },
  };
});
vi.mock('./coding-file.js', async (original) => {
  const actual = await original<typeof Files>();
  return {
    ...actual,
    codingFile: async (...args: Parameters<typeof actual.codingFile>) => {
      const result = await actual.codingFile(...args);
      if (reads.enabled) reads.onFile(args[1]);
      return result;
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      if (reads.enabled && !reads.allowed) reads.afterLossPaths++;
      return result;
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  reads.enabled = false;
  reads.allowed = true;
  reads.git = [];
  reads.afterLossGit = 0;
  reads.afterLossPaths = 0;
  reads.onGit = () => {};
  reads.onFile = () => {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const guard = {
  inspect: () => reads.allowed,
  authorize: () => {
    throw Error('inspection must not consume dispatch');
  },
};
it.each([0, 1, 2, 3])(
  'fences every later actual verification read after Git step%s loses inspection',
  async (step) => {
    const f = codingWorktreeFixture();
    roots.push(f.root);
    const binding = await f.worktrees.create(f.task, await f.worktrees.plan(f.task));
    let revoked = 0,
      failure: unknown;
    reads.onGit = () => {
      if (reads.git.length === step + 1) {
        reads.allowed = false;
        revoked++;
      }
    };
    reads.enabled = true;
    try {
      await f.worktrees.verify(f.task, binding, guard);
    } catch (error) {
      failure = error;
    }
    expect(revoked).toBe(1);
    expect(reads.afterLossGit).toBe(0);
    expect(reads.afterLossPaths).toBe(0);
    expect(reads.git).toHaveLength(step + 1);
    expect(failure).toBeDefined();
  },
);
it('refuses the actual plan Git/realpath reads when inspection is already lost', async () => {
  const f = codingWorktreeFixture();
  roots.push(f.root);
  reads.allowed = false;
  reads.enabled = true;
  let failure: unknown;
  try {
    await f.worktrees.plan(f.task, guard);
  } catch (error) {
    failure = error;
  }
  expect(reads.git).toHaveLength(0);
  expect(reads.afterLossPaths).toBe(0);
  expect(failure).toBeDefined();
});
it('does not start post-confirm verification after loss during the final actual file scan', async () => {
  const f = codingWorktreeFixture();
  roots.push(f.root);
  const binding = await f.worktrees.create(f.task, await f.worktrees.plan(f.task));
  let confirming = false,
    revoked = 0,
    failure: unknown;
  reads.onFile = (path) => {
    if (confirming && path === 'mode.sh') {
      reads.allowed = false;
      revoked++;
    }
  };
  reads.enabled = true;
  const snapshots = new GitCodingSnapshots({
    betweenScans: async () => {
      await Promise.resolve();
      confirming = true;
    },
  });
  try {
    await snapshots.capture(f.task, binding, guard);
  } catch (error) {
    failure = error;
  }
  expect(revoked).toBe(1);
  expect(reads.afterLossGit).toBe(0);
  expect(reads.afterLossPaths).toBe(0);
  expect(failure).toBeDefined();
});
