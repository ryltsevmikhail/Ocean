import type { CodingPolicy } from './coding-policy.js';
import type { CodingApplyReceipt } from './coding-apply.js';
import type { CodingFileContent, CodingWorktree } from './changeset.js';
export type CodingBackupContent = Pick<CodingFileContent, 'mode' | 'sha256'>;
export interface CodingBackupFile {
  readonly path: string;
  readonly before: CodingBackupContent | null;
  readonly after: CodingBackupContent | null;
}
/** External-asset references bound to an immutable database snapshot, not execution authority. */
export interface CodingBackupInventory {
  readonly format: 1;
  readonly hash: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly policyVersion: 1;
    readonly policy: CodingPolicy;
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
    readonly files: readonly CodingBackupFile[];
  }[];
  readonly applications: readonly {
    readonly id: string;
    readonly taskId: string;
    readonly changesetHash: string;
    readonly status: CodingApplyReceipt['status'];
    readonly recoveryProtocol: 2 | null;
    readonly files: CodingApplyReceipt['files'];
  }[];
}

/** Bounded path/status evidence shared by inventory readers and external asset collectors. */
export function validCodingBackupFiles(files: CodingApplyReceipt['files']): boolean {
  return (
    Array.isArray(files) &&
    files.length <= 1000 &&
    files.every(
      (file: CodingApplyReceipt['files'][number]) =>
        typeof file?.path === 'string' &&
        file.path.length > 0 &&
        file.path.length <= 4096 &&
        !file.path.includes('\0') &&
        ['pending', 'started', 'completed', 'uncertain'].includes(file.status),
    )
  );
}
