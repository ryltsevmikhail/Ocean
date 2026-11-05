import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
export interface ReceiptOwner {
  family: 'model' | 'legacy';
  connectionId: string;
}
export function receiptOwner(method: string, connectionId: string): ReceiptOwner {
  return { family: method.startsWith('provider.') ? 'legacy' : 'model', connectionId };
}
export function witness(profile: string, requestId: string) {
  const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
  try {
    const rows = db.prepare('SELECT payload FROM ocean_model_connections').all();
    const row = rows
      .map((r) => JSON.parse(String(r['payload'])) as Record<string, unknown>)
      .find((r) => r['requestId'] === requestId);
    const model = db
      .prepare(
        'SELECT connection_id,result FROM ocean_model_connection_receipts WHERE request_id=?',
      )
      .all(requestId);
    const legacy = db
      .prepare('SELECT provider,result FROM ocean_provider_receipts WHERE request_id=?')
      .all(requestId);
    return { row, model, legacy };
  } finally {
    db.close();
  }
}
export function pendingWitness(profile: string, requestId: string, owner: ReceiptOwner) {
  const w = witness(profile, requestId);
  assert.equal(w.row?.['connectionId'] === owner.connectionId, true, 'pending connection mismatch');
  assert.equal(w.row?.['intent'], 'pending');
  assert.ok(w.row?.['pendingRequest']);
  assert.ok(w.row?.['pendingSecretChange']);
  assert.equal(w.model.length + w.legacy.length, 0);
  return w;
}
export function activeWitness(profile: string, requestId: string, owner: ReceiptOwner) {
  const w = witness(profile, requestId);
  assert.equal(w.row?.['connectionId'] === owner.connectionId, true, 'active connection mismatch');
  assert.equal(w.row?.['intent'], 'active');
  assert.equal(w.row?.['pendingRequest'], null);
  assert.equal(w.row?.['pendingSecretChange'], null);
  assert.equal(w[owner.family].length, 1, 'owning receipt count');
  assert.equal(w[owner.family === 'model' ? 'legacy' : 'model'].length, 0, 'foreign receipt count');
  const row = w[owner.family][0]!;
  assert.equal(
    owner.family === 'model'
      ? row['connection_id'] === owner.connectionId
      : 'legacy:' + row['provider'] === owner.connectionId,
    true,
    'receipt connection mismatch',
  );
  return w;
}
export function settingsWitness(profile: string) {
  const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
  try {
    const plugins = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ocean_plugin_%' ORDER BY name",
      )
      .all()
      .map((r) => String(r['name']));
    return JSON.stringify(
      [
        'ocean_model_connections',
        'ocean_model_connection_receipts',
        'ocean_provider_receipts',
        ...plugins,
      ].map((table) => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()),
    );
  } finally {
    db.close();
  }
}

export function publicReceipt(w: ReturnType<typeof activeWitness>, owner: ReceiptOwner): unknown {
  const envelope = JSON.parse(String(w[owner.family][0]!['result'])) as {
    publicResult?: { status: unknown };
    result: unknown;
  };
  return owner.family === 'model' ? envelope.publicResult!.status : envelope.result;
}
