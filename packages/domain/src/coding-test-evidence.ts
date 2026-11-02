import type { CodingApprovalBinding } from './coding-approval.js';
export interface CodingTestEvidence {
  readonly id: string;
  readonly hash: string;
  readonly binding: CodingApprovalBinding;
  readonly invocationHash: string;
  readonly beforeTreeHash: string;
  readonly afterTreeHash: string;
  readonly dependencyHash: string;
  readonly dependenciesUnchanged: boolean;
  readonly exitCode: number | null;
  readonly reason: 'exit' | 'timeout' | 'cancelled' | 'unavailable';
  readonly cleanupConfirmed: boolean;
  readonly truncated: boolean;
  readonly output: string;
}
/** Passed evidence is scoped to the exact approved source and verified process cleanup. */
export function codingTestPassed(evidence: CodingTestEvidence): boolean {
  return (
    evidence.binding.operation === 'test' &&
    evidence.exitCode === 0 &&
    evidence.reason === 'exit' &&
    evidence.cleanupConfirmed &&
    !evidence.truncated &&
    evidence.dependenciesUnchanged &&
    evidence.beforeTreeHash === evidence.binding.sourceTreeHash &&
    evidence.afterTreeHash === evidence.beforeTreeHash
  );
}
