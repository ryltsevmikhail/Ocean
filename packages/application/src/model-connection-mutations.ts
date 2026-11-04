import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelConnectionDescriptor } from './model-credential-ports.js';
import type { ModelConnectionReadModel } from './model-connection-state.js';
import type { ModelConnectionResolution } from './model-connection-resolution.js';
import { publishModelSecret } from './model-connection-publication.js';
export interface MutationReceiptPolicy<T> {
  replay(requestId: string, binding: string): T | null;
  snapshot(record: ModelConnectionRecord, resolution: ModelConnectionResolution): T;
  activate(
    record: ModelConnectionRecord,
    expected: number | null,
    requestId: string,
    binding: string,
    result: T,
  ): void;
  readonly legacy?: boolean;
}
export interface ModelMutationRequest {
  readonly connectionId: string;
  readonly requestId: string;
  readonly binding: string;
  /** undefined is the historic legacy auto-CAS, never the new create contract. */
  readonly expected: number | null | undefined;
}
export class ModelConnectionMutations<T> {
  readonly state: ModelConnectionReadModel;
  readonly receipts: MutationReceiptPolicy<T>;
  constructor(state: ModelConnectionReadModel, receipts: MutationReceiptPolicy<T>) {
    this.state = state;
    this.receipts = receipts;
  }
  assertWritable(): void {
    const o = this.state.options;
    if (o.mutationsAllowed === false) throw Error('restore_restricted');
    if (o.injected !== null && o.injected !== undefined) throw Error('provider_injected');
    if (o.disabled === true) throw Error('provider_unavailable');
  }
  set(
    request: ModelMutationRequest,
    descriptor: ModelConnectionDescriptor,
    key: string | undefined,
  ): T {
    const replay = this.#replay(request);
    if (replay !== null) return replay;
    const current = this.#read(request);
    if (current?.requestId === request.requestId && current.intent === 'pending')
      return this.#resume(current, request, key);
    this.#revision(current, request.expected);
    if (
      current !== null &&
      (current.providerId !== descriptor.providerId || current.kind !== descriptor.kind)
    )
      throw Error('invalid_params');
    if (
      !this.state.options.factory
        .catalog(descriptor)
        .some((m) => m.modelId === descriptor.defaultModelId)
    )
      throw Error('provider_invalid_model');
    if (current?.intent === 'pending' && key === undefined) throw Error('provider_unverified');
    if (descriptor.auth === 'none' && (descriptor.kind !== 'local' || key !== undefined))
      throw Error('invalid_params');
    const oldRef = current?.secretRef ?? null;
    const nextRef =
      key === undefined
        ? descriptor.auth === 'none'
          ? null
          : oldRef
        : 'psec_' + this.state.options.nextId();
    const configured = descriptor.auth === 'none' || nextRef !== null;
    const next: ModelConnectionRecord = {
      ...descriptor,
      secretRef: nextRef,
      intent: 'active',
      revision: (current?.revision ?? 0) + 1,
      requestId: request.requestId,
      binding: request.binding,
      lastCheck: current?.lastCheck ?? null,
      updatedAt: this.state.options.clock.now().toISOString(),
      pendingSecretChange: null,
      legacyEnvironment: current?.legacyEnvironment ?? this.receipts.legacy === true,
      configuredAfterRestore: configured || (current?.configuredAfterRestore ?? false),
    };
    if (key !== undefined || (descriptor.auth === 'none' && oldRef !== null)) {
      const pending: ModelConnectionRecord = {
        ...next,
        intent: 'pending',
        pendingSecretChange:
          key !== undefined
            ? { action: 'replace', previousRef: oldRef, nextRef }
            : { action: 'remove', previousRef: oldRef, nextRef: null },
      };
      this.state.options.store.put(pending, current?.revision ?? null);
      return this.#resume(pending, request, key);
    }
    const resolution = this.state.resolve(next);
    if (oldRef !== null && resolution.credential === null) throw Error('provider_unverified');
    if (!this.receipts.legacy && resolution.credential === null)
      throw Error('provider_unavailable');
    return this.#commit(next, current?.revision ?? null, request, resolution);
  }
  revise(request: ModelMutationRequest, action: 'disconnect' | 'remove'): T {
    const replay = this.#replay(request);
    if (replay !== null) return replay;
    const current = this.#read(request);
    if (current?.requestId === request.requestId && current.intent === 'pending')
      return this.#resume(current, request, undefined);
    this.#revision(current, request.expected);
    if (current === null) throw Error('connection_not_found');
    const next: ModelConnectionRecord = {
      ...current,
      intent: action === 'disconnect' ? 'disconnected' : 'active',
      secretRef: action === 'remove' ? null : current.secretRef,
      revision: current.revision + 1,
      requestId: request.requestId,
      binding: request.binding,
      updatedAt: this.state.options.clock.now().toISOString(),
      pendingSecretChange: null,
    };
    if (action === 'remove' && current.secretRef !== null) {
      const pending: ModelConnectionRecord = {
        ...next,
        intent: 'pending',
        pendingSecretChange: { action: 'remove', previousRef: current.secretRef, nextRef: null },
      };
      this.state.options.store.put(pending, current.revision);
      return this.#resume(pending, request, undefined);
    }
    return this.#commit(next, current.revision, request, this.state.resolve(next));
  }
  #replay(request: ModelMutationRequest): T | null {
    this.assertWritable();
    return this.receipts.replay(request.requestId, request.binding);
  }
  #read(request: ModelMutationRequest): ModelConnectionRecord | null {
    const store = this.state.options.store;
    const current = store.read(request.connectionId);
    if (
      store
        .list()
        .some(
          (row) => row.connectionId !== request.connectionId && row.requestId === request.requestId,
        )
    )
      throw Error('request_conflict');
    if (this.receipts.legacy && current !== null && !current.legacyEnvironment)
      throw Error('provider_unverified');
    if (current?.requestId === request.requestId && current.binding !== request.binding)
      throw Error('request_conflict');
    return current;
  }
  #revision(current: ModelConnectionRecord | null, expected: number | null | undefined): void {
    if (expected !== undefined && (current?.revision ?? null) !== expected)
      throw Error('revision_conflict');
  }
  #resume(
    pending: ModelConnectionRecord,
    request: ModelMutationRequest,
    key: string | undefined,
  ): T {
    publishModelSecret(pending, key, this.state.options.secrets);
    const next: ModelConnectionRecord = { ...pending, intent: 'active', pendingSecretChange: null };
    const resolution = this.state.resolve(next);
    if (
      (pending.pendingSecretChange?.action === 'replace' || next.auth === 'none') &&
      resolution.credential === null
    )
      throw Error('provider_unverified');
    return this.#commit(next, pending.revision, request, resolution);
  }
  #commit(
    next: ModelConnectionRecord,
    expected: number | null,
    request: ModelMutationRequest,
    resolution: ModelConnectionResolution,
  ): T {
    const result = this.receipts.snapshot(next, resolution);
    this.receipts.activate(next, expected, request.requestId, request.binding, result);
    return result;
  }
}
