import type {
  BotModelBinding,
  ModelExecutionIdentity,
  ModelTransferIdentity,
} from '@runnets/domain';
import type { ModelConnectionStorePort } from './model-connection-ports.js';
import { validModelConnectionEndpoint } from './model-connection-input.js';

/** Metadata only. Availability, credentials and qualification are activation concerns. */
export function bindingTransferIdentity(
  binding: BotModelBinding | null | undefined,
  connections: Pick<ModelConnectionStorePort, 'read'>,
): ModelTransferIdentity {
  if (!binding) return 'unknown';
  const record = connections.read(binding.connectionId);
  return record !== null &&
    (record.kind === 'local' || record.kind === 'cloud') &&
    validModelConnectionEndpoint(record.kind, record.endpoint)
    ? record.kind
    : 'unknown';
}
/** Frozen authority stays independent of the current bot binding. */
export function activationTransferIdentity(
  identity: ModelExecutionIdentity | undefined,
): ModelTransferIdentity {
  return identity?.source === 'connection' &&
    (identity.kind === 'local' || identity.kind === 'cloud') &&
    validModelConnectionEndpoint(identity.kind, identity.endpoint)
    ? identity.kind
    : 'unknown';
}
