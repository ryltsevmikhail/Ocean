import type {
  LocalModelPendingRequest,
  LocalModelConnectionMetadata,
  LocalModelConnectionsPage,
  LocalModelConnectionRecovery,
} from './local-model-connections.js';
import { isLocalProviderSetRequest, isLocalProviderRevisionRequest } from './local-provider.js';
import {
  modelObject as obj,
  modelText as text,
  modelPositive as positive,
  modelEnum as en,
  modelNullable as nullable,
  modelPage,
} from './local-model-validation.js';
import {
  isLocalModelConnectionSetRequest,
  isLocalModelConnectionRevisionRequest,
  isLocalModelCheckMetadata,
  descriptorKeys,
  descriptor,
  catalog,
  qualification,
} from './local-model-connections-validate.js';
const setKeys = [
  'connectionId',
  'requestId',
  'expectedRevision',
  'providerId',
  'kind',
  'endpoint',
  'auth',
  'defaultModelId',
];
export function isLocalModelPendingRequest(v: unknown): v is LocalModelPendingRequest {
  if (
    !obj(v, ['version', 'operation']) ||
    v['version'] !== 1 ||
    !obj(v['operation'], ['method', 'input'], ['keyWasSupplied'])
  )
    return false;
  const op = v['operation'];
  switch (op['method']) {
    case 'modelConnections.set':
      return (
        obj(op, ['method', 'input', 'keyWasSupplied']) &&
        typeof op['keyWasSupplied'] === 'boolean' &&
        obj(op['input'], setKeys) &&
        isLocalModelConnectionSetRequest(op['input'])
      );
    case 'provider.set':
      return (
        obj(op, ['method', 'input', 'keyWasSupplied']) &&
        typeof op['keyWasSupplied'] === 'boolean' &&
        obj(op['input'], ['requestId', 'model']) &&
        isLocalProviderSetRequest(op['input'])
      );
    case 'modelConnections.removeSavedKey':
      return obj(op, ['method', 'input']) && isLocalModelConnectionRevisionRequest(op['input']);
    case 'provider.removeSavedKey':
      return obj(op, ['method', 'input']) && isLocalProviderRevisionRequest(op['input']);
    default:
      return false;
  }
}
function recovery(v: unknown): v is LocalModelConnectionRecovery {
  if (v === null) return true;
  if (
    !obj(v, ['kind', 'pendingRevision'], ['request', 'requiresKeyResupply', 'requestId']) ||
    !positive(v['pendingRevision'])
  )
    return false;
  switch (v['kind']) {
    case 'original_input_required':
      return (
        obj(v, ['kind', 'pendingRevision', 'requestId']) &&
        nullable(v['requestId'], (x) => text(x, 128))
      );
    case 'explicit_key_repair_required':
      return obj(v, ['kind', 'pendingRevision']);
    case 'retry_available':
      return (
        obj(v, ['kind', 'pendingRevision', 'request', 'requiresKeyResupply']) &&
        isLocalModelPendingRequest(v['request']) &&
        v['requiresKeyResupply'] ===
          ('keyWasSupplied' in v['request'].operation && v['request'].operation.keyWasSupplied)
      );
    default:
      return false;
  }
}
export function isLocalModelConnectionMetadata(v: unknown): v is LocalModelConnectionMetadata {
  if (
    !obj(v, [
      ...descriptorKeys,
      'configuration',
      'models',
      'lastCheck',
      'localQualification',
      'recovery',
      'writable',
      'restriction',
    ]) ||
    !descriptor(v)
  )
    return false;
  const c = v['configuration'];
  const r = v['recovery'];
  if (
    !obj(c, ['intent', 'savedKeyReferencePresent', 'configuredAfterRestore']) ||
    !en(c['intent'], ['unconfigured', 'active', 'disconnected', 'pending']) ||
    typeof c['savedKeyReferencePresent'] !== 'boolean' ||
    typeof c['configuredAfterRestore'] !== 'boolean' ||
    !recovery(r)
  )
    return false;
  if (c['intent'] === 'pending' && r === null) return false;
  if (r !== null && (c['intent'] !== 'pending' || r.pendingRevision !== v['revision']))
    return false;
  if (r?.kind === 'retry_available') {
    const op = r.request.operation;
    if ('connectionId' in op.input && op.input.connectionId !== v['connectionId']) return false;
    if (
      'expectedRevision' in op.input &&
      (op.input.expectedRevision ?? 0) + 1 !== r.pendingRevision
    )
      return false;
    if (
      (op.method === 'provider.set' || op.method === 'provider.removeSavedKey') &&
      v['connectionId'] !== `legacy:${v['providerId'] as string}`
    )
      return false;
    if (op.method === 'provider.set' && op.input.model !== v['defaultModelId']) return false;
    if (
      op.method === 'modelConnections.set' &&
      ['providerId', 'kind', 'endpoint', 'auth', 'defaultModelId'].some(
        (k) => op.input[k as keyof typeof op.input] !== v[k],
      )
    )
      return false;
  }
  return (
    catalog(v['models']) &&
    nullable(
      v['lastCheck'],
      (x) => isLocalModelCheckMetadata(x) && x.connectionId === v['connectionId'],
    ) &&
    nullable(v['localQualification'], qualification) &&
    typeof v['writable'] === 'boolean' &&
    en(v['restriction'], [
      'restore_restricted',
      'provider_injected',
      'provider_unavailable',
      null,
    ]) &&
    v['writable'] === (v['restriction'] === null)
  );
}
export const isLocalModelConnectionsPage = (v: unknown): v is LocalModelConnectionsPage =>
  modelPage(v, ['workspaceId'], isLocalModelConnectionMetadata, 256) &&
  nullable(v['workspaceId'], (x) => text(x, 128));
