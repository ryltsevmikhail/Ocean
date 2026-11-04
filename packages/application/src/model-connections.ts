import type {
  ModelConnectionRevisionInput,
  ModelConnectionSetInput,
  ModelConnectionStatus,
} from './model-connection-types.js';
import {
  ModelConnectionReadModel,
  type ModelConnectionServiceOptions,
} from './model-connection-state.js';
import { ModelConnectionMutations } from './model-connection-mutations.js';
import { bindingFor, keyDigest, validKey, validRevision } from './provider-connection-request.js';
import { boundedModelText, modelRevision, validateModelSet } from './model-connection-input.js';
export type { ModelConnectionServiceOptions } from './model-connection-state.js';
export class ModelConnectionService {
  readonly #state: ModelConnectionReadModel;
  readonly #mutations: ModelConnectionMutations<ModelConnectionStatus>;
  readonly options: ModelConnectionServiceOptions;
  constructor(options: ModelConnectionServiceOptions) {
    this.options = options;
    this.#state = new ModelConnectionReadModel(options);
    this.#mutations = new ModelConnectionMutations(this.#state, {
      replay: (id, binding) => {
        const receipt = options.store.receipt(id);
        if (receipt === null) return null;
        if (receipt.binding !== binding) throw Error('request_conflict');
        if (receipt.publicResult === undefined) throw Error('receipt_result_unavailable');
        return receipt.publicResult.status;
      },
      snapshot: (record, resolution) => this.#state.snapshot(record, resolution),
      activate: (record, expected, requestId, binding, status) =>
        options.store.activate(record, expected, {
          requestId,
          value: { binding, result: record, publicResult: { version: 1, status } },
        }),
    });
  }
  status(connectionId: string) {
    return this.#state.status(connectionId);
  }
  list() {
    return this.options.store.list().map((record) => this.#state.snapshot(record));
  }
  current(connectionId: string) {
    const record = this.#state.record(connectionId);
    if (this.options.disabled === true) return null;
    return this.options.injected ?? this.#state.resolve(record).credential?.provider ?? null;
  }
  check(connectionId: string, signal?: AbortSignal) {
    return this.#state.check(connectionId, signal);
  }
  set(input: ModelConnectionSetInput): ModelConnectionStatus {
    this.#mutations.assertWritable();
    const connectionId = boundedModelText(input.connectionId, 256);
    const requestId = boundedModelText(input.requestId, 128);
    const expected = modelRevision(input.expectedRevision);
    const key = input.key === undefined ? undefined : validKey(input.key);
    const binding = bindingFor(this.options.sha256, [
      'ModelConnectionSet',
      connectionId,
      expected,
      input.providerId,
      input.kind,
      input.endpoint,
      input.auth,
      input.defaultModelId,
      keyDigest(this.options.sha256, key),
    ]);
    // Descriptor validation has no factory/store/secret effects and never changes a replay snapshot.
    validateModelSet(input);
    return this.#mutations.set(
      { connectionId, requestId, expected, binding },
      {
        connectionId,
        providerId: input.providerId,
        kind: input.kind,
        endpoint: input.endpoint,
        auth: input.auth,
        defaultModelId: input.defaultModelId,
      },
      key,
    );
  }
  disconnect(input: ModelConnectionRevisionInput) {
    return this.#revise(input, 'disconnect');
  }
  removeSavedKey(input: ModelConnectionRevisionInput) {
    return this.#revise(input, 'remove');
  }
  #revise(input: ModelConnectionRevisionInput, action: 'disconnect' | 'remove') {
    const connectionId = boundedModelText(input.connectionId, 256);
    const requestId = boundedModelText(input.requestId, 128);
    const expected = validRevision(input.expectedRevision);
    const binding = bindingFor(this.options.sha256, [
      action === 'disconnect' ? 'ModelConnectionDisconnect' : 'ModelConnectionRemoveSavedKey',
      connectionId,
      expected,
    ]);
    return this.#mutations.revise({ connectionId, requestId, expected, binding }, action);
  }
}
