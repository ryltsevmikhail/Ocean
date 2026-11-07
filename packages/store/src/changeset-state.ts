import type { CodingArtifactTransaction, ChangesetReceipt } from '@runnets/application';
import type { Changeset, CodingWorktree } from '@runnets/domain';
export interface CodingArtifactState {
  worktrees: Map<string, CodingWorktree>;
  changesets: Map<string, Changeset>;
  captures: Map<string, ChangesetReceipt>;
}
export const newCodingArtifacts = (): CodingArtifactState => ({
  worktrees: new Map(),
  changesets: new Map(),
  captures: new Map(),
});
export function memoryCodingArtifacts(state: CodingArtifactState): CodingArtifactTransaction {
  return {
    worktree: (id) => state.worktrees.get(id) ?? null,
    putWorktree: (value) => {
      const old = state.worktrees.get(value.taskId);
      if (
        old &&
        (JSON.stringify({ ...old, state: value.state }) !== JSON.stringify(value) ||
          (old.state !== 'preparing' && old.state !== value.state))
      )
        throw Error('Immutable worktree');
      state.worktrees.set(value.taskId, structuredClone(value));
    },
    changeset: (id, taskId) => {
      const snapshot = state.changesets.get(id);
      return snapshot && (taskId === undefined || snapshot.taskId === taskId) ? snapshot : null;
    },
    latestChangeset: (taskId) =>
      [...state.changesets.values()].filter((v) => v.taskId === taskId).at(-1) ?? null,
    putChangeset: (value) => {
      const old = state.changesets.get(value.hash);
      if (old && JSON.stringify(old) !== JSON.stringify(value)) throw Error('Immutable changeset');
      state.changesets.set(value.hash, structuredClone(value));
    },
    captureReceipt: (id) => state.captures.get(id) ?? null,
    putCaptureReceipt: (id, value) => {
      if (state.captures.has(id)) throw Error('Duplicate capture receipt');
      state.captures.set(id, structuredClone(value));
    },
  };
}
