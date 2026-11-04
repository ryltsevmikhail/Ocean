/* eslint-disable no-restricted-imports -- Same-package canonical persistence fixture. */
import type {
  LegacyModelConnectionStorePort,
  ModelConnectionRecord,
  ModelConnectionReceipt,
} from '../src/model-connection-ports.js';
import type {
  ProviderConnectionReceipt,
  ProviderConnectionRecord,
} from '../src/provider-connection-ports.js';
import { unconfiguredModelConnection } from '../src/model-connection-ports.js';
export function memoryModelStore() {
  const rows = new Map<string, ModelConnectionRecord>();
  const receipts = new Map<string, ModelConnectionReceipt>();
  const legacyReceipts = new Map<string, ProviderConnectionReceipt>();
  const clone = <T>(v: T): T => structuredClone(v);
  const store: LegacyModelConnectionStorePort = {
    list: () =>
      clone([...rows.values()].sort((a, b) => a.connectionId.localeCompare(b.connectionId))),
    read: (id) => clone(rows.get(id) ?? null),
    put(record, expected) {
      if (
        record.requestId !== null &&
        [...rows.values()].some(
          (row) => row.connectionId !== record.connectionId && row.requestId === record.requestId,
        )
      )
        throw Error('request_conflict');
      if ((rows.get(record.connectionId)?.revision ?? null) !== expected)
        throw Error('revision_conflict');
      rows.set(record.connectionId, clone(record));
    },
    activate(record, expected, receipt) {
      if (receipts.has(receipt.requestId) || legacyReceipts.has(receipt.requestId))
        throw Error('request_conflict');
      store.put(record, expected);
      receipts.set(receipt.requestId, clone(receipt.value));
    },
    activateLegacy(record, expected, receipt) {
      if (receipts.has(receipt.requestId) || legacyReceipts.has(receipt.requestId))
        throw Error('request_conflict');
      store.put(record, expected);
      legacyReceipts.set(receipt.requestId, clone(receipt.value));
    },
    receipt(id) {
      if (legacyReceipts.has(id)) throw Error('request_conflict');
      return clone(receipts.get(id) ?? null);
    },
    legacyReceipt(id) {
      if (receipts.has(id)) throw Error('request_conflict');
      return clone(legacyReceipts.get(id) ?? null);
    },
  };
  return { store, rows, receipts, legacyReceipts };
}
export function legacyFixtureStore() {
  const model = memoryModelStore();
  const rows = new (class extends Map<string, ProviderConnectionRecord> {
    override set(provider: string, row: ProviderConnectionRecord) {
      model.rows.delete(`legacy:${provider}`);
      return super.set(provider, row);
    }
  })();
  const canonicalRead = model.store.read;
  model.store.read = (id) => {
    const persisted = canonicalRead(id);
    if (persisted !== null) return persisted;
    const old = rows.get(id.slice(7));
    if (!old) return null;
    return {
      ...unconfiguredModelConnection(old.provider),
      defaultModelId: old.model,
      secretRef: old.secretRef,
      intent: old.intent,
      revision: old.revision,
      requestId: old.requestId,
      binding: old.binding,
      lastCheck: old.lastCheck === null ? null : { ...old.lastCheck, connectionId: id },
      updatedAt: old.updatedAt,
    };
  };
  model.store.list = () =>
    [...new Set([...model.rows.keys(), ...[...rows.keys()].map((id) => `legacy:${id}`)])]
      .sort()
      .map((id) => model.store.read(id)!);
  model.store.put = (record, expected) => {
    if ((model.store.read(record.connectionId)?.revision ?? null) !== expected)
      throw Error('revision_conflict');
    model.rows.set(record.connectionId, structuredClone(record));
    const { connectionId: _id, ...check } = record.lastCheck ?? { connectionId: '' };
    if (record.intent !== 'unconfigured')
      Map.prototype.set.call(rows, record.providerId, {
        provider: record.providerId,
        model: record.defaultModelId,
        secretRef: record.secretRef,
        intent: record.intent,
        revision: record.revision,
        requestId: record.requestId,
        binding: record.binding,
        lastCheck: record.lastCheck === null ? null : check,
        updatedAt: record.updatedAt,
      });
  };
  return { ...model, rows };
}
