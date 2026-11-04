import type { DatabaseSync } from 'node:sqlite';
import {
  type ModelConnectionRecord,
  type ModelConnectionReceipt,
  type LegacyModelConnectionStorePort,
  type ProviderConnectionReceipt,
  modelPublicResult,
} from '@runnets/application';
import { legacyProviderReceipt } from './legacy-provider-rows.js';
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
  const current = readModelConnection(db, record.connectionId);
  if (record.requestId !== null) {
    if (current?.requestId !== record.requestId) assertModelReceiptAvailable(db, record.requestId);
    if (
      db
        .prepare(
          "SELECT connection_id FROM ocean_model_connections WHERE connection_id<>? AND json_extract(payload,'$.requestId')=?",
        )
        .get(record.connectionId, record.requestId)
    )
      throw Error('request_conflict');
  }
  if ((current?.revision ?? null) !== expected) throw Error('revision_conflict');
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

export class SqliteModelConnections implements LegacyModelConnectionStorePort {
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
    const result = modelConnectionRecord(receipt.value.result);
    if (
      result.connectionId !== record.connectionId ||
      result.revision !== record.revision ||
      typeof receipt.value.binding !== 'string'
    )
      throw Error('connection_unverified');
    const publicResult =
      receipt.value.publicResult === undefined
        ? undefined
        : modelPublicResult(receipt.value.publicResult);
    if (
      publicResult !== undefined &&
      (publicResult.status.connectionId !== record.connectionId ||
        publicResult.status.revision !== record.revision)
    )
      throw Error('connection_unverified');
    const payload = publicResult === undefined ? result : { version: 1, result, publicResult };
    this.#activate(record, expected, receipt.requestId, () => {
      this.#db
        .prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)')
        .run(
          receipt.requestId,
          record.connectionId,
          receipt.value.binding,
          JSON.stringify(payload),
        );
    });
  }
  activateLegacy(
    record: ModelConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ProviderConnectionReceipt },
  ): void {
    if (
      !record.legacyEnvironment ||
      readModelConnection(this.#db, record.connectionId)?.legacyEnvironment === false ||
      record.connectionId !== `legacy:${record.providerId}`
    )
      throw Error('provider_unverified');
    this.#activate(record, expected, receipt.requestId, () => {
      this.#db
        .prepare('INSERT INTO ocean_provider_receipts VALUES(?,?,?,?)')
        .run(
          receipt.requestId,
          record.providerId,
          receipt.value.binding,
          JSON.stringify(receipt.value),
        );
    });
  }
  #activate(
    record: ModelConnectionRecord,
    expected: number | null,
    requestId: string,
    receipt: () => void,
  ): void {
    withImmediateTransaction(this.#db, () => {
      assertModelReceiptAvailable(this.#db, requestId);
      writeModelConnection(this.#db, record, expected);
      receipt();
    });
  }
  legacyReceipt(id: string): ProviderConnectionReceipt | null {
    const row = this.#db
      .prepare('SELECT result FROM ocean_provider_receipts WHERE request_id=?')
      .get(id);
    if (row) return legacyProviderReceipt(row['result']);
    if (
      this.#db
        .prepare('SELECT request_id FROM ocean_model_connection_receipts WHERE request_id=?')
        .get(id)
    )
      throw Error('request_conflict');
    return null;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(row['result'] as string) as unknown;
    } catch {
      throw Error('connection_unverified');
    }
    const envelope =
      parsed !== null && typeof parsed === 'object' && 'version' in parsed
        ? (parsed as Record<string, unknown>)
        : null;
    if (envelope !== null && envelope['version'] !== 1) throw Error('connection_unverified');
    const result =
      envelope === null
        ? decodeModelConnection(row['result'])
        : modelConnectionRecord(envelope['result']);
    const publicResult =
      envelope === null ? undefined : modelPublicResult(envelope['publicResult']);
    if (
      result.connectionId !== row['connection_id'] ||
      typeof row['binding'] !== 'string' ||
      (publicResult !== undefined &&
        (publicResult.status.connectionId !== result.connectionId ||
          publicResult.status.revision !== result.revision))
    )
      throw Error('connection_unverified');
    return {
      binding: row['binding'],
      result,
      ...(publicResult === undefined ? {} : { publicResult }),
    };
  }
}

/** Destination restore metadata is reset inside restoration.install's existing transaction. */
export function resetRestoredModelConnections(db: DatabaseSync): void {
  const connections = new SqliteModelConnections(db).list();
  for (const record of connections)
    writeModelConnection(db, { ...record, configuredAfterRestore: false }, record.revision);
}
