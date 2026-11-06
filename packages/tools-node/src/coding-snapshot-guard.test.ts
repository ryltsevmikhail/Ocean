import { expect, it, vi } from 'vitest';
import { GitCodingSnapshots } from './coding-snapshot.js';
import type { CodingTask, WorktreeBinding } from '@runnets/domain';
const state = vi.hoisted(() => ({
  allowed: true,
  revokeAtVerify: false,
  base: 0,
  tree: 0,
  verifications: 0,
  revokeAtFinalScan: false,
}));
vi.mock('./coding-worktree.js', () => ({
  GitCodingWorktrees: class {
    async verify() {
      await Promise.resolve();
      state.verifications++;
      if (state.revokeAtVerify) state.allowed = false;
    }
  },
}));
vi.mock('./coding-working-tree.js', () => ({
  codingBaseFiles: async () => {
    state.base++;
    return new Map();
  },
  codingWorkingTree: async () => {
    state.tree++;
    if (state.revokeAtFinalScan && state.tree === 2) state.allowed = false;
    return new Map();
  },
  codingManifest: () => 'same',
}));
it.each(['verification', 'confirm', 'final-scan'] as const)(
  'refuses subsequent physical snapshot reads after %s authority loss',
  async (at) => {
    state.allowed = true;
    state.revokeAtVerify = at === 'verification';
    state.base = 0;
    state.tree = 0;
    state.verifications = 0;
    state.revokeAtFinalScan = at === 'final-scan';
    const snapshots = new GitCodingSnapshots({
      betweenScans: async () => {
        await Promise.resolve();
        if (at === 'confirm') state.allowed = false;
      },
    });
    const task = { id: 'task', baseCommit: 'base' } as CodingTask,
      binding = { root: '/worktree' } as WorktreeBinding;
    await expect(
      snapshots.capture(task, binding, {
        authorize: () => {
          throw Error('must not consume dispatch');
        },
        inspect: () => state.allowed,
      }),
    ).rejects.toThrow();
    expect(state.base).toBe(at === 'verification' ? 0 : 1);
    expect(state.tree).toBe(at === 'verification' ? 0 : at === 'final-scan' ? 2 : 1);
    expect(state.verifications).toBe(1);
  },
);
