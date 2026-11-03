import type { CodingTestEvidence } from '@runnets/domain';
export interface CodingTestEvidenceStore {
  put(evidence: CodingTestEvidence): void;
  /** Read at most one matching serialized evidence row, refusing before materialization if oversized. */
  latestForPreset(
    taskId: string,
    presetId: string,
    maxBytes: number,
  ): { evidence: CodingTestEvidence; bytes: number } | null;
  list(taskId: string): readonly CodingTestEvidence[];
}
