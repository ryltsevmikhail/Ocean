import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { boundCodingEffect } from '@runnets/application';
import {
  canonicalJson,
  codingApprovalClaimKey,
  validToolEffectAdmission,
  type CodingApproval,
  type ToolEffectAdmission,
} from '@runnets/domain';
import { codingProjectId } from './service-run-scope.js';
import { approvalOf, digest } from './coding-claim-evidence.js';

export function readToolAdmission(raw: unknown): ToolEffectAdmission | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validToolEffectAdmission(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
export function exactCodingReceipt(
  a: CodingApproval,
  actual: ToolEffectAdmission | undefined,
): boolean {
  if (a.guardedDispatch !== true || !actual || a.binding.operation === 'apply') return false;
  const expected = boundCodingEffect(
    a.binding,
    a.grantReference ?? null,
    codingProjectId(a.binding.projectRoot),
  );
  return canonicalJson(actual) === canonicalJson(expected);
}
/** undefined means no associated coding claim. null means the coding evidence contradicts its journal. */
export function journalCodingApproval(
  db: DatabaseSync,
  row: Record<string, SQLOutputValue>,
): CodingApproval | null | undefined {
  // Invocation identity establishes association; a contradictory tool name cannot erase it.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='ocean_coding_approval_claims'").get())
    return undefined;
  const key = 'CASE WHEN json_valid(c.invocation_key) THEN c.invocation_key END';
  const rows = db
    .prepare(
      `SELECT c.invocation_key,c.approval_id,a.payload FROM ocean_coding_approval_claims c LEFT JOIN ocean_coding_approvals a ON a.id=c.approval_id
 WHERE json_extract(${key},'$[4]')=? AND json_extract(${key},'$[5]')=? AND json_extract(${key},'$[6]')=?`,
    )
    .all(row['task_run_id'] ?? null, row['attempt_id'] ?? null, row['id'] ?? null);
  if (!rows.length) return undefined;
  if (rows.length !== 1) return null;
  const claim = rows[0]!;
  try {
    const a = approvalOf(claim['payload']);
    return a &&
      a.status === 'consumed' &&
      a.id === claim['approval_id'] &&
      codingApprovalClaimKey(a) === claim['invocation_key'] &&
      row['tool'] === 'coding_' + a.binding.operation &&
      digest(JSON.stringify({ ...a, status: 'allowed' })) === row['fingerprint']
      ? a
      : null;
  } catch {
    return null;
  }
}
