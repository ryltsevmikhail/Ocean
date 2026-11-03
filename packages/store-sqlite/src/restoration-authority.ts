import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { ProfileRebindRecord } from '@runnets/domain';
import { validateRebindResult } from '@runnets/application';
import { restoreOriginStore } from './restore-origin.js';
import { SqliteOwnerDecisions } from './owner-decisions.js';
export function activeRebind(db: DatabaseSync): ProfileRebindRecord | null {
  const row = db
    .prepare(
      `SELECT r.* FROM ocean_execution_epoch e JOIN ocean_profile_rebinds r
    ON r.request_id=e.request_id WHERE e.singleton=1`,
    )
    .get();
  if (!row) return null;
  const r = JSON.parse(String(row['payload'])) as ProfileRebindRecord;
  if (
    r.requestId !== row['request_id'] ||
    r.revision !== row['revision'] ||
    row['state'] !== 'ready' ||
    r.state !== 'ready' ||
    !r.result ||
    r.preview.selection.requestId !== r.requestId ||
    r.bindingDigest !== createHash('sha256').update(JSON.stringify(r.preview)).digest('hex') ||
    JSON.stringify(r.preview.origin) !== JSON.stringify(restoreOriginStore(db).origin())
  )
    throw Error('invalid_execution_epoch');
  const p = r.preview;
  const decision = new SqliteOwnerDecisions(db).find({
    workspaceId: p.selection.workspaceId,
    roomId: p.selection.roomId,
    runId: 'rebind-' + p.epochId,
    decisionId: r.decisionId,
  });
  if (
    decision?.kind !== 'restore-rebind' ||
    decision.status !== 'allowed' ||
    decision.version !== 2 ||
    decision.bindingDigest !== r.bindingDigest
  )
    throw Error('invalid_execution_epoch');
  validateRebindResult(r, r.result);
  return r;
}
/** Read-only UI admission; no migration, lease acquisition or source path observation. */
export function readRestorationAuthority(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ocean_restore_origin'")
        .get()
    )
      return { origin: null, active: null };
    return { origin: restoreOriginStore(db).origin(), active: activeRebind(db) };
  } finally {
    db.close();
  }
}
