import { createHash } from 'node:crypto';
import { assertNewOwnerDecision, reviewDecisionId } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ConversationReceipt,
  DecisionOutcome,
  OwnerDecision,
  OwnerDecisionRef,
  OwnerDecisionScope,
  OwnerDecisionStore,
} from '@runnets/application';
export function migrateOwnerDecisions(db: DatabaseSync) {
  db.exec(`CREATE TABLE ocean_owner_decisions (
   decisionId TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, roomId TEXT NOT NULL, runId TEXT NOT NULL,
   kind TEXT NOT NULL, bindingDigest TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
   version INTEGER NOT NULL, status TEXT NOT NULL, previewLength INTEGER NOT NULL, preview BLOB NOT NULL, revision INTEGER NOT NULL
 ) STRICT;
 CREATE INDEX ocean_decisions_by_room ON ocean_owner_decisions(workspaceId,roomId,decisionId);
 CREATE INDEX ocean_decision_revision ON ocean_owner_decisions(revision);
 CREATE INDEX ocean_room_decision_revision ON ocean_owner_decisions(workspaceId,roomId,revision);
 CREATE INDEX ocean_decisions_by_run ON ocean_owner_decisions(workspaceId,roomId,runId,status);
 `);
}
const columns =
  'decisionId, workspaceId, roomId, runId, kind, bindingDigest, createdAt, expiresAt, version, status, previewLength';
const byRef = 'WHERE workspaceId=? AND roomId=? AND runId=? AND decisionId=?';
const key = (ref: OwnerDecisionRef) => [ref.workspaceId, ref.roomId, ref.runId, ref.decisionId];
export class SqliteOwnerDecisions implements OwnerDecisionStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  insert(c: OwnerDecision, preview: string) {
    assertNewOwnerDecision(c, preview);
    this.db
      .prepare(
        'INSERT INTO ocean_owner_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,(SELECT coalesce(max(revision),0)+1 FROM ocean_owner_decisions))',
      )
      .run(
        c.decisionId,
        c.workspaceId,
        c.roomId,
        c.runId,
        c.kind,
        c.bindingDigest,
        c.createdAt,
        c.expiresAt,
        c.version,
        c.status,
        c.previewLength,
        Buffer.from(preview, 'utf16le'),
      );
  }
  has(id: string) {
    return (
      this.db.prepare('SELECT 1 FROM ocean_owner_decisions WHERE decisionId=?').get(id) !==
      undefined
    );
  }
  find(ref: OwnerDecisionRef) {
    return (
      (this.db
        .prepare('SELECT ' + columns + ' FROM ocean_owner_decisions ' + byRef)
        .get(...key(ref)) as unknown as OwnerDecision | undefined) ?? null
    );
  }
  preview(ref: OwnerDecisionRef, offset = 0, length = 0x7fffffff) {
    const bytes = this.db
      .prepare('SELECT substr(preview,?,?) AS bytes FROM ocean_owner_decisions ' + byRef)
      .get(offset * 2 + 1, length * 2, ...key(ref))?.['bytes'];
    return bytes instanceof Uint8Array ? Buffer.from(bytes).toString('utf16le') : null;
  }
  list(
    scope: OwnerDecisionScope,
    after: string,
    limit: number,
    excludeKind?: OwnerDecision['kind'],
  ) {
    return this.db
      .prepare(
        'SELECT ' +
          columns +
          ' FROM ocean_owner_decisions WHERE workspaceId=? AND roomId=? AND decisionId>? AND kind<>? ORDER BY decisionId LIMIT ?',
      )
      .all(
        scope.workspaceId,
        scope.roomId,
        after,
        excludeKind ?? '',
        limit,
      ) as unknown as OwnerDecision[];
  }
  settle(expected: OwnerDecision, outcome: DecisionOutcome) {
    return (
      this.db
        .prepare(
          'UPDATE ocean_owner_decisions SET status=?,version=version+1,revision=(SELECT max(revision)+1 FROM ocean_owner_decisions) ' +
            byRef +
            " AND status='pending' AND bindingDigest=? AND version=?",
        )
        .run(outcome, ...key(expected), expected.bindingDigest, expected.version).changes === 1
    );
  }
  retirePending() {
    this.db.exec(
      "UPDATE ocean_owner_decisions SET status='interrupted',version=version+1,revision=(SELECT max(revision)+1 FROM ocean_owner_decisions) WHERE status='pending'",
    );
  }
}

// Early schema-11 review cards predate receipt reservations. Preserve their key as a
// read-only request tombstone. It has no acknowledgement binding and cannot be promoted.
export function legacyReviewKey(db: DatabaseSync): (id: string) => ConversationReceipt | null {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='ocean_owner_decisions' AND type='table'")
      .get()
  )
    return () => null;
  const workspace = db.prepare('SELECT id FROM ocean_workspace WHERE singleton=1');
  const legacy = db.prepare(
    "SELECT roomId,runId FROM ocean_owner_decisions WHERE decisionId=? AND workspaceId=? AND kind='continue-text-only'",
  );
  return (requestId) => {
    const workspaceId = workspace.get()?.['id'];
    if (typeof workspaceId !== 'string') return null;
    const id = reviewDecisionId(workspaceId, requestId, (text) =>
      createHash('sha256').update(text).digest('hex'),
    );
    const row = legacy.get(id, workspaceId);
    if (!row) return null;
    return {
      binding: 'retired-review-request',
      reply: {
        kind: 'review_request',
        data: { id, workspaceId, roomId: String(row['roomId']), taskRunId: String(row['runId']) },
      },
    };
  };
}
