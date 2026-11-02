import type { CodingTestEvidence } from '@runnets/domain';
export interface CodingTestEvidenceStore {
  put(evidence: CodingTestEvidence): void;
  list(taskId: string): readonly CodingTestEvidence[];
}
