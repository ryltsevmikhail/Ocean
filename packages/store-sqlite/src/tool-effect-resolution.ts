import type { DatabaseSync } from 'node:sqlite';
/** Independently versioned journal metadata, like tool_invocations_v1/v2. */
export function createEffectResolutions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_effect_resolutions_v1 (
    id TEXT NOT NULL, task_run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(task_run_id,attempt_id,id)
  ) STRICT`);
}
/**
 * An uncertain effect keeps the global hold until its exact owner resolution
 * exists. Only two writers create a resolution row, and each validates the
 * effect first (`coding_apply` reconciliation, service-plugin operation
 * acknowledgement). The original uncertain outcome is never rewritten; only
 * its exact resolution excludes the hold.
 */
export function unresolvedEffectSql(alias: string): string {
  return `${alias}.outcome IN ('started','uncertain') AND NOT (
    ${alias}.outcome='uncertain' AND EXISTS (
      SELECT 1 FROM tool_effect_resolutions_v1 r WHERE r.id=${alias}.id
      AND r.task_run_id=${alias}.task_run_id AND r.attempt_id=${alias}.attempt_id
      AND r.fingerprint=${alias}.fingerprint))`;
}
