import {
  canonicalJson,
  validServiceOwnerOperationsQuery,
  type ServiceConnection,
  type ServiceCatalogSnapshot,
  type ServiceOwnerOperationsQuery,
} from '@runnets/domain';
import type { ServiceAuthorityTransaction } from './service-authority-ports.js';
import { currentServiceCatalog } from './service-catalog-policy.js';
import type { ServiceOwnerReceipt } from './service-owner-receipt.js';
const BOUND = 400000;
export function ownerConnections(
  tx: ServiceAuthorityTransaction,
  ownerId: string,
  ready?: (connection: ServiceConnection, catalog: ServiceCatalogSnapshot) => boolean,
) {
  const result = [];
  let size = 2;
  for (const c of tx.listConnections({ ownerId, limit: 100 })) {
    const catalog = currentServiceCatalog(tx, c);
    const readiness =
      c.state === 'disconnected'
        ? ('disconnected' as const)
        : !catalog
          ? ('metadata_required' as const)
          : !ready
            ? ('unknown' as const)
            : ready(c, catalog)
              ? ('ready' as const)
              : ('unavailable' as const);
    const view = { ...c, tools: catalog?.tools.map((t) => t.name) ?? [], readiness };
    size += canonicalJson(view).length + 1;
    if (size > BOUND) break;
    result.push(view);
  }
  return result;
}
export function ownerGrants(tx: ServiceAuthorityTransaction, ownerId: string) {
  const result = [];
  let size = 2;
  for (const grant of tx.listGrants({ ownerId, limit: 100 })) {
    size += canonicalJson(grant).length + 1;
    if (size > BOUND) break;
    result.push(grant);
  }
  return result;
}
function operationView(r: ServiceOwnerReceipt) {
  return {
    requestId: r.requestId,
    method: r.method,
    state: r.state,
    recovery: r.state === 'prepared' ? ('explicit_recovery_required' as const) : null,
    targetId:
      r.operation?.input.connectionId ??
      (r.result && ('connectionId' in r.result ? r.result.connectionId : r.result.id)),
    operation: r.operation ? structuredClone(r.operation) : null,
  };
}
export function ownerOperations(
  tx: ServiceAuthorityTransaction,
  ownerId: string,
  query: ServiceOwnerOperationsQuery,
) {
  if (!validServiceOwnerOperationsQuery(query)) throw Error('invalid_params');
  const rows = tx.listOwnerReceipts(ownerId, query),
    items = [];
  let size = 300; // Envelope plus the maximum opaque cursor, including escaped characters.
  for (const row of rows) {
    const item = operationView(row);
    size += canonicalJson(item).length + 1;
    if (items.length === (query.limit ?? 50) || size > BOUND) break;
    items.push(item);
  }
  return { items, next: rows.length > items.length ? (items.at(-1)?.requestId ?? null) : null };
}
