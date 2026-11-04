/** Legacy facade: canonical rows own metadata; old tables retain only migration evidence/receipts. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  ProviderConnectionReceipt,
  ProviderConnectionRecord,
  ProviderConnectionStorePort,
} from '@runnets/application';
import {
  canonicalProviderRecord,
  legacyProviderRecord,
  legacyProviderReceipt,
} from './legacy-provider-rows.js';
import {
  assertModelReceiptAvailable,
  readModelConnection,
  writeModelConnection,
} from './model-connection-storage.js';
import { withImmediateTransaction } from './transaction.js';

export class SqliteProviderConnections implements ProviderConnectionStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  read(provider: string): ProviderConnectionRecord | null {
    const record = readModelConnection(this.#db, `legacy:${provider}`);
    // The old DTO cannot carry an explicit environment restriction, even across saved-key removal.
    if (record !== null && !record.legacyEnvironment) throw Error('provider_unverified');
    return record === null ? null : legacyProviderRecord(record);
  }
  put(record: ProviderConnectionRecord, expected: number | null): void {
    withImmediateTransaction(this.#db, () => this.#write(record, expected));
  }
  activate(
    record: ProviderConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ProviderConnectionReceipt },
  ): void {
    withImmediateTransaction(this.#db, () => {
      assertModelReceiptAvailable(this.#db, receipt.requestId);
      this.#write(record, expected, record.intent === 'active');
      this.#db
        .prepare('INSERT INTO ocean_provider_receipts VALUES(?,?,?,?)')
        .run(
          receipt.requestId,
          record.provider,
          receipt.value.binding,
          JSON.stringify(receipt.value),
        );
    });
  }
  receipt(requestId: string): ProviderConnectionReceipt | null {
    // Legacy retry semantics always consult the original result bytes before current metadata.
    const row = this.#db
      .prepare('SELECT result FROM ocean_provider_receipts WHERE request_id=?')
      .get(requestId);
    if (row) return legacyProviderReceipt(row['result']);
    if (
      this.#db
        .prepare('SELECT request_id FROM ocean_model_connection_receipts WHERE request_id=?')
        .get(requestId)
    )
      throw Error('request_conflict');
    return null;
  }
  #write(record: ProviderConnectionRecord, expected: number | null, configured = false): void {
    const current = readModelConnection(this.#db, `legacy:${record.provider}`);
    if (current !== null && !current.legacyEnvironment) throw Error('provider_unverified');
    const revision =
      current === null || current.intent === 'unconfigured' ? null : current.revision;
    if (revision !== expected) throw Error('revision_conflict');
    const next = canonicalProviderRecord(record, current ?? undefined);
    if (!next.legacyEnvironment) throw Error('provider_unverified');
    writeModelConnection(
      this.#db,
      {
        ...next,
        configuredAfterRestore: configured || next.configuredAfterRestore,
      },
      current?.revision ?? null,
    );
  }
}
