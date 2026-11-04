import type { DatabaseSync } from 'node:sqlite';
import type {
  ModelConnectionRecord,
  ModelConnectionReceipt,
  ModelConnectionStorePort,
} from '@runnets/application';
import { withImmediateTransaction } from './transaction.js';
import { decodeModelConnection, modelConnectionRecord } from './model-connection-record.js';

/** Low-level helpers never start transactions; bot insertion and migration already own one. */
export function readModelConnection(db: DatabaseSync, id: string): ModelConnectionRecord | null {
  const row = db
    .prepare('SELECT payload FROM ocean_model_connections WHERE connection_id=?')
    .get(id);
  if (!row) return null;
  const record = decodeModelConnection(row['payload']);
  if (record.connectionId !== id) throw Error('connection_unverified');
  return record;
}
export function writeModelConnection(
  db: DatabaseSync,
  input: ModelConnectionRecord,
  expected: number | null,
): void {
  const record = modelConnectionRecord(input);
  if ((readModelConnection(db, record.connectionId)?.revision ?? null) !== expected)
    throw Error('revision_conflict');
  db.prepare(
    `INSERT INTO ocean_model_connections VALUES(?,?) ON CONFLICT(connection_id)
    DO UPDATE SET payload=excluded.payload`,
  ).run(record.connectionId, JSON.stringify(record));
}
/** Both API generations share one idempotency namespace without reinterpreting result types. */
export function assertModelReceiptAvailable(db: DatabaseSync, id: string): void {
  if (
    db
      .prepare(
        `SELECT request_id FROM ocean_provider_receipts WHERE request_id=?
    UNION ALL SELECT request_id FROM ocean_model_connection_receipts WHERE request_id=?`,
      )
      .get(id, id)
  )
    throw Error('request_conflict');
}

export class SqliteModelConnections implements ModelConnectionStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  list(): readonly ModelConnectionRecord[] {
    return this.#db
      .prepare('SELECT connection_id FROM ocean_model_connections ORDER BY connection_id')
      .all()
      .map((row) => readModelConnection(this.#db, String(row['connection_id']))!);
  }
  read(id: string): ModelConnectionRecord | null {
    return readModelConnection(this.#db, id);
  }
  put(record: ModelConnectionRecord, expected: number | null): void {
    withImmediateTransaction(this.#db, () => writeModelConnection(this.#db, record, expected));
  }
  activate(
    record: ModelConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ModelConnectionReceipt },
  ): void {
    withImmediateTransaction(this.#db, () => {
      assertModelReceiptAvailable(this.#db, receipt.requestId);
      const result = modelConnectionRecord(receipt.value.result);
      if (
        result.connectionId !== record.connectionId ||
        result.revision !== record.revision ||
        typeof receipt.value.binding !== 'string'
      )
        throw Error('connection_unverified');
      writeModelConnection(this.#db, record, expected);
      this.#db
        .prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)')
        .run(receipt.requestId, record.connectionId, receipt.value.binding, JSON.stringify(result));
    });
  }
  receipt(id: string): ModelConnectionReceipt | null {
    if (
      this.#db.prepare('SELECT request_id FROM ocean_provider_receipts WHERE request_id=?').get(id)
    )
      throw Error('request_conflict');
    const row = this.#db
      .prepare('SELECT * FROM ocean_model_connection_receipts WHERE request_id=?')
      .get(id);
    if (!row) return null;
    const result = decodeModelConnection(row['result']);
    if (result.connectionId !== row['connection_id'] || typeof row['binding'] !== 'string')
      throw Error('connection_unverified');
    return { binding: row['binding'], result };
  }
}

/** Destination restore metadata is reset inside restoration.install's existing transaction. */
export function resetRestoredModelConnections(db: DatabaseSync): void {
  const connections = new SqliteModelConnections(db).list();
  for (const record of connections)
    writeModelConnection(db, { ...record, configuredAfterRestore: false }, record.revision);
}
