import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  canonicalJson,
  MANAGED_LIFETIME_RUN,
  MANAGED_LIFETIME_TOOL,
  managedLifetimeFingerprint,
  validManagedLifetime,
  validManagedBusinessAdmission,
  type ToolEffectAdmission,
} from '@runnets/domain';
import { readToolAdmission } from './coding-journal-receipt.js';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
type Identity = {
  readonly id: string;
  readonly tool: string;
  readonly taskRunId: string;
  readonly attemptId: string;
};
const identity = (r: Record<string, SQLOutputValue>): Identity => ({
  id: String(r['id']),
  tool: String(r['tool']),
  taskRunId: String(r['task_run_id']),
  attemptId: String(r['attempt_id']),
});
export function exactManagedLifetime(
  row: Record<string, SQLOutputValue>,
  admission: ToolEffectAdmission,
): boolean {
  const r = { ...identity(row), admission };
  return validManagedLifetime(r) && sha(managedLifetimeFingerprint(r)) === row['fingerprint'];
}
function integrity(r: Identity, admission: ToolEffectAdmission, request: string) {
  return sha(
    canonicalJson({
      identity: { id: r.id, tool: r.tool, taskRunId: r.taskRunId, attemptId: r.attemptId },
      request,
      admission,
    }),
  );
}
/** Existing TEXT fingerprint carries a versioned request hash and independently checkable admission seal. */
export function managedBusinessFingerprint(
  r: Identity,
  admission: ToolEffectAdmission,
  request: string,
): string {
  const digest = sha(request);
  return 'managed-business-v1:' + digest + ':' + integrity(r, admission, digest);
}
export function exactManagedBusiness(
  db: DatabaseSync,
  row: Record<string, SQLOutputValue>,
  admission: ToolEffectAdmission,
): boolean {
  if (!validManagedBusinessAdmission(admission)) return false;
  const b = admission.binding as Record<string, unknown>;
  if (b['tool'] !== row['tool']) return false;
  const match = /^managed-business-v1:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(
    String(row['fingerprint']),
  );
  if (!match || integrity(identity(row), admission, match[1]!) !== match[2]) return false;
  const lives = db
    .prepare('SELECT * FROM tool_invocations_v2 WHERE task_run_id=? AND tool=? AND fingerprint=?')
    .all(MANAGED_LIFETIME_RUN, MANAGED_LIFETIME_TOOL, String(b['managedSession']));
  if (lives.length !== 1) return false;
  const life = lives[0]!,
    a = readToolAdmission(life['admission']);
  if (
    !a ||
    !exactManagedLifetime(life, a) ||
    !['started', 'completed', 'uncertain'].includes(String(life['outcome']))
  )
    return false;
  const bound = a.binding as Record<string, unknown>;
  return (
    b['connectionId'] === bound['connectionId'] &&
    b['managedEnrollment'] === bound['managedEnrollment'] &&
    canonicalJson(b['managedWorkspace']) === canonicalJson(bound['managedWorkspace'])
  );
}
