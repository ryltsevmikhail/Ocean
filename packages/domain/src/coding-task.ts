import { err, type Result } from './errors.js';
import type { CodingCapability, CodingPolicy } from './coding-policy.js';
export type CodingErrorCode =
  | 'unsupported_file'
  | 'changeset_limit'
  | 'stale_capture'
  | 'worktree_unavailable'
  | 'coding_unavailable'
  | 'invalid_input'
  | 'coding_denied'
  | 'project_busy'
  | 'request_conflict'
  | 'approval_required'
  | 'recovery_required'
  | 'project_changed';
export type CodingResult<T> = Result<T, { readonly code: CodingErrorCode }>;
export const codingFailure = (code: CodingErrorCode): CodingResult<never> => err({ code });
export interface ProjectLeaseHolder {
  readonly ownerId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly binding: string;
  readonly kind: 'coding' | 'legacy-write' | 'legacy-command';
}
export interface ProjectLease extends ProjectLeaseHolder {
  readonly projectRoot: string;
  readonly token: string;
}
export interface CodingTask {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly worktreeRoot: string | null;
  readonly ownerRoomId: string;
  readonly devBotId: string;
  readonly reviewBotId: string;
  readonly reviewRoomId: string;
  readonly status: 'reserved' | 'cancelled';
  readonly policyVersion: 1;
  readonly policy: CodingPolicy;
  readonly lease: ProjectLease;
  readonly createdAt: string;
}
export interface CodingAccess {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly policyVersion: number;
  readonly capability: CodingCapability;
}
/** Parent/child roots conflict too; an uncontained legacy command claims the global scope. */
export function projectRootsOverlap(a: string, b: string): boolean {
  return (
    a === '*' ||
    b === '*' ||
    a === b ||
    a === '/' ||
    b === '/' ||
    a.startsWith(b + '/') ||
    b.startsWith(a + '/')
  );
}
