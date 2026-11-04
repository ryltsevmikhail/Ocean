/**
 * SQLite provider connection metadata adapter.
 *
 * Writes are compare-and-set on the owner-visible revision, so a stale owner
 * request can never overwrite a newer configuration. Activation persists the
 * activated record and its idempotency receipt in one transaction.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  readCheckMetadata,
  type ProviderConnectionIntent,
  type ProviderConnectionReceipt,
  type ProviderConnectionRecord,
  type ProviderConnectionStorePort,
} from '@runnets/application';

const TABLE = 'ocean_provider_connections';
const RECEIPTS = 'ocean_provider_receipts';
const INTENTS: readonly ProviderConnectionIntent[] = ['active', 'disconnected', 'pending'];
const UPSERT = `INSERT INTO ${TABLE}
  (provider, model, secret_ref, intent, revision, request_id, binding, last_check, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider) DO UPDATE SET
    model=excluded.model, secret_ref=excluded.secret_ref, intent=excluded.intent,
    revision=excluded.revision, request_id=excluded.request_id, binding=excluded.binding,
    last_check=excluded.last_check, updated_at=excluded.updated_at`;

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function text(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new Error(`provider connection ${column} is not text`);
  return value;
}
function integer(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`provider connection ${column} is not an integer`);
  return value;
}
function parseCheck(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Malformed check metadata is dropped; the connection state itself stays authoritative.
    return null;
  }
}
function parseResult(value: unknown): ProviderConnectionReceipt {
  try {
    const parsed = JSON.parse(text(value, 'result')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('receipt');
    const receipt = parsed as Record<string, unknown>;
    if (typeof receipt['binding'] !== 'string' || typeof receipt['result'] !== 'object')
      throw new Error('receipt');
    return { binding: receipt['binding'], result: receipt['result'] } as ProviderConnectionReceipt;
  } catch {
    throw new Error('provider_unverified');
  }
}
/** Injected transaction wrapper: the adapter never owns a foreign outer transaction. */
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
export class SqliteProviderConnections implements ProviderConnectionStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  read(provider: string): ProviderConnectionRecord | null {
    const row = this.#db.prepare(`SELECT * FROM ${TABLE} WHERE provider = ?`).get(provider) as
      Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const intent = INTENTS.find((candidate) => candidate === row['intent']);
    if (intent === undefined) throw new Error('provider_unverified');
    const lastCheck = parseCheck(row['last_check']);
    return {
      provider: text(row['provider'], 'provider'),
      model: optionalText(row['model']),
      secretRef: optionalText(row['secret_ref']),
      intent,
      revision: integer(row['revision'], 'revision'),
      requestId: optionalText(row['request_id']),
      binding: optionalText(row['binding']),
      lastCheck: readCheckMetadata(lastCheck),
      updatedAt: text(row['updated_at'], 'updated_at'),
    };
  }
  put(record: ProviderConnectionRecord, expected: number | null): void {
    transaction(this.#db, () => this.#write(record, expected));
  }
  activate(
    record: ProviderConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ProviderConnectionReceipt },
  ): void {
    transaction(this.#db, () => {
      this.#write(record, expected);
      try {
        this.#db
          .prepare(
            `INSERT INTO ${RECEIPTS} (request_id, provider, binding, result) VALUES (?, ?, ?, ?)`,
          )
          .run(
            receipt.requestId,
            record.provider,
            receipt.value.binding,
            JSON.stringify(receipt.value),
          );
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE'))
          throw new Error('request_conflict');
        throw error;
      }
    });
  }
  receipt(requestId: string): ProviderConnectionReceipt | null {
    const row = this.#db
      .prepare(`SELECT binding, result FROM ${RECEIPTS} WHERE request_id = ?`)
      .get(requestId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return parseResult(row['result']);
  }
  #write(record: ProviderConnectionRecord, expected: number | null): void {
    const current = this.#db
      .prepare(`SELECT revision FROM ${TABLE} WHERE provider = ?`)
      .get(record.provider) as Record<string, unknown> | undefined;
    if ((current === undefined ? null : integer(current['revision'], 'revision')) !== expected)
      throw new Error('revision_conflict');
    this.#db
      .prepare(UPSERT)
      .run(
        record.provider,
        record.model,
        record.secretRef,
        record.intent,
        record.revision,
        record.requestId,
        record.binding,
        record.lastCheck === null ? null : JSON.stringify(record.lastCheck),
        record.updatedAt,
      );
  }
}
