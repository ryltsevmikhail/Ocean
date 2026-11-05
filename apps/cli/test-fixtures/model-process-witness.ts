import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
export function witness(profile: string, requestId: string) {
  const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
  try {
    const rows = db.prepare('SELECT payload FROM ocean_model_connections').all();
    const row = rows
      .map((r) => JSON.parse(String(r['payload'])) as Record<string, unknown>)
      .find((r) => r['requestId'] === requestId);
    const model = db
      .prepare('SELECT result FROM ocean_model_connection_receipts WHERE request_id=?')
      .all(requestId);
    const legacy = db
      .prepare('SELECT result FROM ocean_provider_receipts WHERE request_id=?')
      .all(requestId);
    return { row, model, legacy };
  } finally {
    db.close();
  }
}
export function pendingWitness(profile: string, requestId: string) {
  const w = witness(profile, requestId);
  assert.equal(w.row?.['intent'], 'pending');
  assert.ok(w.row?.['pendingRequest']);
  assert.ok(w.row?.['pendingSecretChange']);
  assert.equal(w.model.length + w.legacy.length, 0);
  return w;
}
export function activeWitness(profile: string, requestId: string) {
  const w = witness(profile, requestId);
  assert.equal(w.row?.['intent'], 'active');
  assert.equal(w.row?.['pendingRequest'], null);
  assert.equal(w.row?.['pendingSecretChange'], null);
  assert.equal(w.model.length + w.legacy.length, 1);
  return w;
}
export function settingsWitness(profile: string) {
  const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
  try {
    return JSON.stringify(
      ['ocean_model_connections', 'ocean_model_connection_receipts', 'ocean_provider_receipts'].map(
        (table) => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(),
      ),
    );
  } finally {
    db.close();
  }
}
