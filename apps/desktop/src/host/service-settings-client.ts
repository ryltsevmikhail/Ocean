import {
  LOCAL_SERVICE_AUTHORITY,
  LOCAL_SERVICE_METHODS,
  LOCAL_SERVICE_CONFIRMATIONS,
  LOCAL_PLUGIN_METHODS,
} from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import type { ServiceCommand } from '../service-protocol.js';
export const historicalServiceWriter = (caps: readonly string[]) =>
  !caps.some((c) => c.startsWith('service.') || c === LOCAL_SERVICE_CONFIRMATIONS) &&
  LOCAL_PLUGIN_METHODS.every((c) => caps.includes(c));
export function dispatchServiceSettings(client: LocalRuntimeClient, c: ServiceCommand) {
  const caps = client.identity.capabilities;
  if (
    'binding' in c &&
    c.binding &&
    (c.binding.profileId !== client.identity.profileId ||
      c.binding.instanceId !== client.identity.instanceId)
  )
    throw Error('task_identity_changed');
  const has = (items: readonly string[]) => items.every((x) => caps.includes(x));
  if (c.op === 'service-support')
    return {
      current: has([LOCAL_SERVICE_AUTHORITY, ...LOCAL_SERVICE_METHODS]),
      historicalOnly: historicalServiceWriter(caps),
      historical: has([
        'plugin.catalog',
        'plugin.connections',
        'plugin.access-list',
        'plugin.operations-list',
      ]),
      decisions: has([
        LOCAL_SERVICE_CONFIRMATIONS,
        'decisions.list',
        'decisions.get',
        'decisions.preview',
        'decisions.resolve',
      ]),
    };
  if (!caps.includes(LOCAL_SERVICE_AUTHORITY)) throw Error('service_runtime_upgrade_required');
  if (
    ['service-decisions', 'service-decision', 'service-preview', 'service-resolve'].includes(
      c.op,
    ) &&
    !caps.includes(LOCAL_SERVICE_CONFIRMATIONS)
  )
    throw Error('service_decisions_upgrade_required');
  switch (c.op) {
    case 'service-connections':
      return client.serviceConnections();
    case 'service-grants':
      return client.serviceGrants();
    case 'service-receipt':
      return client.serviceReceipt(c.input);
    case 'service-set':
      return client.setServiceConnection(c.input);
    case 'service-disconnect':
      return client.disconnectServiceConnection(c.input);
    case 'service-refresh':
      return client.refreshServiceConnection(c.input);
    case 'service-grant':
      return client.setOwnerScopeGrant(c.input);
    case 'service-revoke':
      return client.revokeOwnerScopeGrant(c.input);
    case 'service-operations':
      return client.listServiceOwnerOperations(c.input);
    case 'service-decisions':
      return client.listDecisions(c.input);
    case 'service-decision':
      return client.getDecision(c.input);
    case 'service-preview':
      return client.decisionPreview(c.input);
    case 'service-resolve':
      return client.resolveDecision(c.input);
  }
}
