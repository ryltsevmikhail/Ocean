import type {
  Changeset,
  CodingTask,
  CodingWorktree,
  WorktreePlan,
  WorktreeBinding,
} from '@runnets/domain';
export interface WorktreePort {
  preflight(task: CodingTask): Promise<void>;
  plan(task: CodingTask): Promise<WorktreePlan>;
  create(task: CodingTask, plan: WorktreePlan): Promise<WorktreeBinding>;
  verify(task: CodingTask, binding: WorktreeBinding): Promise<void>;
}
export interface ChangesetPort {
  capture(task: CodingTask, binding: WorktreeBinding): Promise<Changeset>;
}
export interface ChangesetReceipt {
  readonly binding: string;
  readonly hash: string;
}
export interface CodingArtifactTransaction {
  worktree(taskId: string): CodingWorktree | null;
  putWorktree(binding: CodingWorktree): void;
  changeset(hash: string): Changeset | null;
  putChangeset(value: Changeset): void;
  captureReceipt(id: string): ChangesetReceipt | null;
  putCaptureReceipt(id: string, value: ChangesetReceipt): void;
}
export interface CodingWorktreeOwnerPort {
  confirm(preview: Readonly<{ task: CodingTask; plan: WorktreePlan }>): Promise<boolean>;
}
