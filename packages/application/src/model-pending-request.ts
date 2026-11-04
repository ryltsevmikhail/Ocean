import type { ModelConnectionRecord } from './model-connection-ports.js';
import type {
  ModelConnectionRevisionInput,
  ModelConnectionSetInput,
} from './model-connection-types.js';
import type { ProviderRevisionInput, ProviderSetInput } from './provider-connection-ports.js';
import { boundedModelText, modelRevision, validateModelSet } from './model-connection-input.js';
import { validModel, validRequestId, validRevision } from './provider-connection-request.js';

export interface ModelPendingRequest {
  readonly version: 1;
  readonly operation:
    | {
        readonly method: 'modelConnections.set';
        readonly input: Omit<ModelConnectionSetInput, 'key'>;
        readonly keyWasSupplied: boolean;
      }
    | {
        readonly method: 'modelConnections.removeSavedKey';
        readonly input: ModelConnectionRevisionInput;
      }
    | {
        readonly method: 'provider.set';
        readonly input: Omit<ProviderSetInput, 'key'>;
        readonly keyWasSupplied: boolean;
      }
    | { readonly method: 'provider.removeSavedKey'; readonly input: ProviderRevisionInput };
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fields(v: unknown, names: readonly string[]): asserts v is Record<string, unknown> {
  if (
    !object(v) ||
    Object.keys(v).length !== names.length ||
    names.some((k) => !Object.hasOwn(v, k))
  )
    throw Error('connection_unverified');
}
/** Closed original input, validated independently of credentials/catalog and detached from JSON. */
export function modelPendingRequest(
  value: unknown,
  row: ModelConnectionRecord,
): ModelPendingRequest | null {
  if (value === undefined || value === null) return null;
  try {
    fields(value, ['version', 'operation']);
    if (value['version'] !== 1) throw Error();
    const op = value['operation'];
    if (!object(op)) throw Error();
    const set = op['method'] === 'modelConnections.set' || op['method'] === 'provider.set';
    fields(op, set ? ['method', 'input', 'keyWasSupplied'] : ['method', 'input']);
    const i = op['input'];
    if (!object(i) || (set && typeof op['keyWasSupplied'] !== 'boolean')) throw Error();
    if (
      row.intent !== 'pending' ||
      row.pendingSecretChange === null ||
      row.requestId === null ||
      row.binding === null ||
      i['requestId'] !== row.requestId
    )
      throw Error();
    const change = row.pendingSecretChange;
    if (
      (change.action === 'replace') !== (set && op['keyWasSupplied'] === true) ||
      (change.action === 'replace'
        ? change.nextRef === null || row.secretRef !== change.nextRef
        : change.nextRef !== null || row.secretRef !== null)
    )
      throw Error();
    switch (op['method']) {
      case 'modelConnections.set': {
        fields(i, [
          'connectionId',
          'requestId',
          'expectedRevision',
          'providerId',
          'kind',
          'endpoint',
          'auth',
          'defaultModelId',
        ]);
        const input: Omit<ModelConnectionSetInput, 'key'> = {
          connectionId: boundedModelText(i['connectionId'], 256),
          requestId: boundedModelText(i['requestId'], 128),
          expectedRevision: modelRevision(i['expectedRevision'] as number | null),
          providerId: boundedModelText(i['providerId'], 64),
          kind: i['kind'] as 'cloud' | 'local',
          endpoint: boundedModelText(i['endpoint'], 2048),
          auth: i['auth'] as 'api_key' | 'none',
          defaultModelId: boundedModelText(i['defaultModelId'], 256),
        };
        validateModelSet(input);
        if (change.action === 'remove' && (input.auth !== 'none' || change.previousRef === null))
          throw Error();
        if (
          input.connectionId !== row.connectionId ||
          input.providerId !== row.providerId ||
          input.kind !== row.kind ||
          input.endpoint !== row.endpoint ||
          input.auth !== row.auth ||
          input.defaultModelId !== row.defaultModelId ||
          (input.auth === 'none' && op['keyWasSupplied'])
        )
          throw Error();
        if ((input.expectedRevision === null ? 1 : input.expectedRevision + 1) !== row.revision)
          throw Error();
        return {
          version: 1,
          operation: {
            method: op['method'],
            input,
            keyWasSupplied: op['keyWasSupplied'] as boolean,
          },
        };
      }
      case 'provider.set': {
        fields(i, ['requestId', 'model']);
        const input = {
          requestId: validRequestId(i['requestId']),
          model: validModel(i['model'], typeof i['model'] === 'string' ? [i['model']] : []),
        };
        if (
          !row.legacyEnvironment ||
          op['keyWasSupplied'] !== true ||
          row.connectionId !== `legacy:${row.providerId}` ||
          input.model !== row.defaultModelId
        )
          throw Error();
        return {
          version: 1,
          operation: {
            method: op['method'],
            input,
            keyWasSupplied: op['keyWasSupplied'] as boolean,
          },
        };
      }
      case 'modelConnections.removeSavedKey': {
        fields(i, ['connectionId', 'requestId', 'expectedRevision']);
        const input = {
          connectionId: boundedModelText(i['connectionId'], 256),
          requestId: boundedModelText(i['requestId'], 128),
          expectedRevision: validRevision(i['expectedRevision']),
        };
        if (
          input.connectionId !== row.connectionId ||
          input.expectedRevision + 1 !== row.revision ||
          change.action !== 'remove'
        )
          throw Error();
        return { version: 1, operation: { method: op['method'], input } };
      }
      case 'provider.removeSavedKey': {
        fields(i, ['requestId', 'expectedRevision']);
        const input = {
          requestId: validRequestId(i['requestId']),
          expectedRevision: validRevision(i['expectedRevision']),
        };
        if (
          !row.legacyEnvironment ||
          input.expectedRevision + 1 !== row.revision ||
          change.action !== 'remove'
        )
          throw Error();
        return { version: 1, operation: { method: op['method'], input } };
      }
      default:
        throw Error();
    }
  } catch {
    throw Error('connection_unverified');
  }
}
