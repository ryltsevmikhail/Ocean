import type { Changeset } from './changeset.js';
export interface CodingReviewBinding {
  readonly taskId: string;
  readonly changesetHash: string;
  readonly baseCommit: string;
  readonly afterTreeHash: string;
  readonly testEvidenceHashes: readonly string[];
}
export interface CodingReviewFinding {
  readonly path: string;
  readonly side: 'before' | 'after';
  readonly line: number;
  readonly severity: 'critical' | 'important' | 'minor';
  readonly explanation: string;
}
export interface CodingReviewVerdict {
  readonly id: string;
  readonly binding: CodingReviewBinding;
  readonly reviewerBotId: string;
  readonly reviewRoomId: string;
  readonly verdict: 'approve' | 'changes_requested' | 'insufficient_context';
  readonly findings: readonly CodingReviewFinding[];
  readonly summary: string;
}
export function codingReviewCurrent(
  binding: CodingReviewBinding,
  changeset: Changeset,
  testEvidenceHashes: readonly string[],
): boolean {
  return (
    binding.taskId === changeset.taskId &&
    binding.changesetHash === changeset.hash &&
    binding.baseCommit === changeset.baseCommit &&
    binding.afterTreeHash === changeset.afterTreeHash &&
    JSON.stringify(binding.testEvidenceHashes) === JSON.stringify(testEvidenceHashes)
  );
}
/** Anchors refer to the complete immutable before/after artifact, never dev prose. */
export function codingReviewFindingValid(
  finding: CodingReviewFinding,
  changeset: Changeset,
): boolean {
  const file = changeset.files.find((file) => file.path === finding.path);
  const content = file?.[finding.side];
  return (
    content !== null &&
    content !== undefined &&
    Number.isSafeInteger(finding.line) &&
    finding.line >= 1 &&
    finding.line <= content.text.split('\n').length &&
    ['critical', 'important', 'minor'].includes(finding.severity) &&
    typeof finding.explanation === 'string' &&
    finding.explanation.trim().length > 0 &&
    finding.explanation.length <= 16384
  );
}
