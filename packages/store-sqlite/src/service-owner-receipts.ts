import type { DatabaseSync } from 'node:sqlite';
import type { ServiceOwnerReceipt } from '@runnets/application';
import {
  validServiceConnection,
  validOwnerScopeGrant,
  validServiceCatalogSnapshot,
} from '@runnets/domain';
export function migrateServiceOwnerReceipts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ocean_service_owner_receipts (
    request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK(state IN ('prepared','completed')),
    record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 131072)
  ) STRICT`);
}
export function readServiceOwnerReceipt(db: DatabaseSync, id: string): ServiceOwnerReceipt | null {
  const row = db.prepare('SELECT * FROM ocean_service_owner_receipts WHERE request_id=?').get(id);
  if (!row) return null;
  const r = JSON.parse(String(row['record'])) as ServiceOwnerReceipt;
  if (
    r.requestId !== id ||
    r.ownerId !== row['owner_id'] ||
    r.state !== row['state'] ||
    !/^[a-f0-9]{64}$/.test(r.binding) ||
    ![
      'service.connection-set',
      'service.connection-disconnect',
      'service.connection-refresh',
      'service.grant-set',
      'service.grant-revoke',
    ].includes(r.method) ||
    (r.state === 'prepared'
      ? r.result !== null
      : !(
          validServiceConnection(r.result) ||
          validOwnerScopeGrant(r.result) ||
          validServiceCatalogSnapshot(r.result)
        ))
  )
    throw Error('invalid service owner receipt');
  return r;
}
export function putServiceOwnerReceipt(
  db: DatabaseSync,
  r: ServiceOwnerReceipt,
  expected: 'prepared' | null,
): boolean {
  const old = readServiceOwnerReceipt(db, r.requestId);
  if (
    expected === null
      ? old !== null
      : !old ||
        old.state !== expected ||
        old.ownerId !== r.ownerId ||
        old.binding !== r.binding ||
        old.method !== r.method
  )
    return false;
  if (expected !== null && r.state !== 'completed') return false;
  db.prepare(
    'INSERT INTO ocean_service_owner_receipts VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET state=excluded.state,record=excluded.record',
  ).run(r.requestId, r.ownerId, r.state, JSON.stringify(r));
  readServiceOwnerReceipt(db, r.requestId);
  return true;
}
