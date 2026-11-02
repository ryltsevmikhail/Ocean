import type { CodingWorktree } from './changeset.js';
/** External-asset references bound to an immutable database snapshot, not execution authority. */
export interface CodingBackupInventory {
  readonly format: 1;
  readonly hash: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly projectRoot: string;
    readonly baseCommit: string;
    readonly worktreeRoot: string | null;
    readonly ownerId: string;
    readonly status: 'reserved' | 'cancelled';
  }[];
  readonly worktrees: readonly CodingWorktree[];
  readonly changesets: readonly {
    readonly hash: string;
    readonly taskId: string;
    readonly baseCommit: string;
    readonly beforeTreeHash: string;
    readonly afterTreeHash: string;
  }[];
  readonly applications: readonly {
    readonly id: string;
    readonly taskId: string;
    readonly changesetHash: string;
    readonly status: 'applying' | 'completed' | 'uncertain' | 'not_started';
  }[];
}
