import type { CodingTask, ProjectLeaseKind } from './coding-task.js';
/**
 * Pure finalization DTOs. The owner confirms one exact prepared task; the
 * profile database then disables it before the coordination registry may lose
 * the exact project reservation. Nothing here performs I/O or hashes data.
 */
export const FINALIZATION_PREVIEW_MS = 300000;
/** `null` epoch means an original (never rebound) profile. */
export interface CodingFinalizationOwnerIdentity {
  readonly profileOwnerId: string;
  readonly epochId: string | null;
}
export interface CodingFinalizationTaskIdentity {
  readonly id: string;
  readonly originalTaskId: string;
  readonly workspaceId: string;
  readonly ownerRoomId: string;
  readonly devBotId: string;
  readonly reviewRoomId: string;
  readonly reviewBotId: string;
  readonly createdAt: string;
}
export interface CodingFinalizationProject {
  readonly root: string;
  readonly baseCommit: string;
  readonly worktreeRoot: string;
}
export interface CodingFinalizationPolicy {
  readonly version: 1;
  readonly digest: string;
}
export interface CodingFinalizationAssets {
  readonly changesets: readonly string[];
  readonly reviews: readonly string[];
  readonly evidence: readonly string[];
}
export interface CodingFinalizationRegistryIdentity {
  readonly path: string;
  readonly schema: string;
}
export interface CodingFinalizationLeaseBinding {
  readonly token: string;
  readonly tokenHash: string;
  readonly holderHash: string;
  readonly projectRoot: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly binding: string;
  readonly kind: ProjectLeaseKind;
  readonly registry: CodingFinalizationRegistryIdentity;
}
export interface CodingFinalizationBinding {
  readonly version: 1;
  readonly operationId: string;
  readonly owner: CodingFinalizationOwnerIdentity;
  readonly task: CodingFinalizationTaskIdentity;
  readonly project: CodingFinalizationProject;
  readonly policy: CodingFinalizationPolicy;
  readonly assets: CodingFinalizationAssets;
  readonly lease: CodingFinalizationLeaseBinding;
}
export interface CodingFinalizationHold {
  readonly id: string;
  readonly kind: string;
  readonly outcome: string;
  readonly scope: 'global' | 'task';
}
export interface CodingFinalizationPreview {
  readonly binding: CodingFinalizationBinding;
  readonly decisionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly holds: readonly CodingFinalizationHold[];
  /** Named asset groups that stay byte-for-byte; omitted work is never implied. */
  readonly retained: readonly string[];
}
export type CodingFinalizationState =
  'preview' | 'finalizing' | 'finalized' | 'uncertain' | 'refused';
export type CodingFinalizationReleaseState = 'not_started' | 'pending' | 'released' | 'unproven';
export type CodingFinalizationReleaseOutcome =
  | 'released'
  | 'absent'
  | 'mismatch'
  | 'receipt_conflict'
  | 'registry_missing'
  | 'registry_corrupt'
  | 'thrown';
export interface CodingFinalizationReleaseIntent {
  readonly operationId: string;
  readonly bindingDigest: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly projectRoot: string;
  readonly tokenHash: string;
  readonly holderHash: string;
  readonly releasedAt: string;
}
export interface CodingFinalizationReleaseReceipt extends CodingFinalizationReleaseIntent {
  readonly version: 1;
  readonly registry: CodingFinalizationRegistryIdentity;
}
export interface CodingFinalizationRelease {
  readonly state: CodingFinalizationReleaseState;
  readonly outcome: CodingFinalizationReleaseOutcome | null;
  readonly receipt: CodingFinalizationReleaseReceipt | null;
  readonly detail: string | null;
}
export interface CodingFinalizationRecord {
  readonly requestId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly revision: number;
  readonly state: CodingFinalizationState;
  readonly decisionId: string;
  readonly bindingDigest: string;
  readonly preview: CodingFinalizationPreview;
  readonly release: CodingFinalizationRelease;
  readonly reason: string | null;
}
export interface CodingFinalizationRetained {
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly worktreeRoot: string;
  readonly policyVersion: 1;
  readonly policyDigest: string;
  readonly changesets: readonly string[];
  readonly reviews: readonly string[];
  readonly evidence: readonly string[];
}
export interface CodingFinalizationResult {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly state: CodingFinalizationState;
  readonly reason: string | null;
  readonly bindingDigest: string;
  readonly taskStatus: CodingTask['status'];
  readonly release: CodingFinalizationRelease;
  readonly retained: CodingFinalizationRetained;
}
export interface CodingFinalizationSelection {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskId: string;
}
const transitions: Record<CodingFinalizationState, readonly CodingFinalizationState[]> = {
  preview: ['finalizing', 'refused'],
  finalizing: ['finalized', 'uncertain'],
  finalized: [],
  uncertain: [],
  refused: [],
};
/** Unknown outcomes are terminal until a separate exact owner decision; never a retry. */
export function codingFinalizationTransition(
  from: CodingFinalizationState,
  to: CodingFinalizationState,
): boolean {
  return transitions[from].includes(to);
}
