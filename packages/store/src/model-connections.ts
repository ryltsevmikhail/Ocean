import {
  modelConnectionRecord,
  type ModelConnectionReceipt,
  type ModelConnectionRecord,
  type ModelConnectionStorePort,
} from '@runnets/application';

export interface MemoryModelConnections {
  connections: Map<string, ModelConnectionRecord>;
  connectionReceipts: Map<string, ModelConnectionReceipt>;
}
export class InMemoryModelConnections implements ModelConnectionStorePort {
  readonly #state: () => MemoryModelConnections;
  constructor(state: () => MemoryModelConnections) {
    this.#state = state;
  }
  list(): readonly ModelConnectionRecord[] {
    return structuredClone(
      [...this.#state().connections.values()].sort((a, b) =>
        a.connectionId.localeCompare(b.connectionId),
      ),
    );
  }
  read(id: string): ModelConnectionRecord | null {
    return structuredClone(this.#state().connections.get(id) ?? null);
  }
  put(record: ModelConnectionRecord, expected: number | null): void {
    const state = this.#state();
    const next = modelConnectionRecord(record);
    if ((state.connections.get(next.connectionId)?.revision ?? null) !== expected)
      throw Error('revision_conflict');
    state.connections.set(next.connectionId, structuredClone(next));
  }
  activate(
    record: ModelConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ModelConnectionReceipt },
  ): void {
    const state = this.#state();
    if (state.connectionReceipts.has(receipt.requestId)) throw Error('request_conflict');
    const result = modelConnectionRecord(receipt.value.result);
    if (
      result.connectionId !== record.connectionId ||
      result.revision !== record.revision ||
      typeof receipt.value.binding !== 'string'
    )
      throw Error('connection_unverified');
    const value = structuredClone({ binding: receipt.value.binding, result });
    this.put(record, expected);
    state.connectionReceipts.set(receipt.requestId, value);
  }
  receipt(id: string): ModelConnectionReceipt | null {
    return structuredClone(this.#state().connectionReceipts.get(id) ?? null);
  }
}
