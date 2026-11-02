import type { ProjectLease } from './coding-task.js';
export type CodingFileMode = '100644' | '100755';
export interface CodingFileContent {
  readonly mode: CodingFileMode;
  readonly text: string;
  readonly sha256: string;
}
export interface CodingFileChange {
  readonly path: string;
  readonly before: CodingFileContent | null;
  readonly after: CodingFileContent | null;
}
export interface Changeset {
  readonly id: string;
  readonly hash: string;
  readonly taskId: string;
  readonly baseCommit: string;
  readonly beforeTreeHash: string;
  readonly afterTreeHash: string;
  readonly files: readonly CodingFileChange[];
  readonly diff: string;
}
export interface WorktreePlan {
  readonly root: string;
  readonly branch: string;
  readonly gitCommonDir: string;
}
export interface WorktreeBinding extends WorktreePlan {
  readonly taskId: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
}
export interface CodingWorktree extends WorktreeBinding {
  readonly workspaceId: string;
  readonly state: 'preparing' | 'ready' | 'uncertain';
  readonly lease: ProjectLease;
}
export type ArtifactErrorCode =
  'unsupported_file' | 'changeset_limit' | 'stale_capture' | 'worktree_unavailable';
export class CodingArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode) {
    super(code);
    this.code = code;
    this.name = 'CodingArtifactError';
  }
}
