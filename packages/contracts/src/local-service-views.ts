import {
  canonicalJson,
  validServiceConnection,
  validOwnerScopeGrant,
  validServiceCatalogSnapshot,
  validServiceOwnerOperation,
  validServiceReceiptQuery,
  type ServiceConnection,
  type OwnerScopeGrant,
  type ServiceCatalogSnapshot,
  type ServiceOwnerOperation,
} from '@runnets/domain';
import { localRuntimeRecord as object } from './local-runtime.js';
export type LocalServiceReadiness =
  'ready' | 'disconnected' | 'metadata_required' | 'unavailable' | 'unknown';
export type LocalServiceConnectionView = ServiceConnection & {
  readonly tools: readonly string[];
  readonly readiness: LocalServiceReadiness;
};
export type LocalServiceOwnerResult = ServiceConnection | OwnerScopeGrant | ServiceCatalogSnapshot;
export interface LocalServiceOwnerReceipt {
  readonly requestId: string;
  readonly method: string;
  readonly state: 'prepared' | 'completed';
  readonly recovery: 'explicit_recovery_required' | null;
  readonly result: LocalServiceOwnerResult | null;
}
export interface LocalServiceOwnerOperationItem extends Omit<LocalServiceOwnerReceipt, 'result'> {
  readonly targetId: string | null;
  readonly operation: ServiceOwnerOperation | null;
}
export interface LocalServiceOwnerOperationsPage {
  readonly items: readonly LocalServiceOwnerOperationItem[];
  readonly next: string | null;
}
const keys = (v: Record<string, unknown>, ks: string[]) =>
  Object.keys(v).length === ks.length && ks.every((k) => Object.hasOwn(v, k));
const text = (v: unknown): v is string => validServiceReceiptQuery({ requestId: v });
const methods = [
  'service.connection-set',
  'service.connection-disconnect',
  'service.connection-refresh',
  'service.grant-set',
  'service.grant-revoke',
];
function base(v: Record<string, unknown>) {
  return (
    text(v['requestId']) &&
    typeof v['method'] === 'string' &&
    methods.includes(v['method']) &&
    (v['state'] === 'prepared'
      ? v['recovery'] === 'explicit_recovery_required'
      : v['state'] === 'completed' && v['recovery'] === null)
  );
}
const bounded = (v: unknown) => {
  try {
    return canonicalJson(v).length <= 400000;
  } catch {
    return false;
  }
};
export function isLocalServiceOwnerReceipt(v: unknown): v is LocalServiceOwnerReceipt {
  if (!object(v) || !keys(v, ['requestId', 'method', 'state', 'recovery', 'result']) || !base(v))
    return false;
  if (v['state'] === 'prepared') return v['result'] === null;
  if (v['method'] === 'service.connection-refresh')
    return validServiceConnection(v['result']) || validServiceCatalogSnapshot(v['result']);
  return v['method'] === 'service.connection-set' || v['method'] === 'service.connection-disconnect'
    ? validServiceConnection(v['result'])
    : validOwnerScopeGrant(v['result']);
}
export function isLocalServiceConnectionView(v: unknown): boolean {
  if (!object(v)) return false;
  const { tools, readiness, ...record } = v;
  return (
    validServiceConnection(record) &&
    Array.isArray(tools) &&
    tools.length <= 256 &&
    Array.from(tools).every((t) => text(t)) &&
    new Set(tools).size === tools.length &&
    (!Object.hasOwn(v, 'readiness') ||
      (typeof readiness === 'string' &&
        ['ready', 'disconnected', 'metadata_required', 'unavailable', 'unknown'].includes(
          readiness,
        )))
  );
}
/** Older authority-v2 peers have no live readiness evidence. */
export function normalizeLocalServiceConnections(
  v: unknown,
): readonly LocalServiceConnectionView[] | null {
  if (
    !Array.isArray(v) ||
    v.length > 100 ||
    !Array.from(v).every(isLocalServiceConnectionView) ||
    !bounded(v)
  )
    return null;
  if (new Set(v.map((c: ServiceConnection) => c.id)).size !== v.length) return null;
  return v.map(
    (c: Omit<LocalServiceConnectionView, 'readiness'> & { readiness?: LocalServiceReadiness }) => ({
      ...c,
      readiness: c.readiness ?? 'unknown',
    }),
  );
}
export function isLocalServiceGrants(v: unknown): v is readonly OwnerScopeGrant[] {
  return (
    Array.isArray(v) &&
    v.length <= 100 &&
    Array.from(v).every(validOwnerScopeGrant) &&
    new Set(v.map((g: OwnerScopeGrant) => g.id)).size === v.length &&
    bounded(v)
  );
}
export function isLocalServiceOwnerOperationItem(v: unknown): v is LocalServiceOwnerOperationItem {
  if (
    !object(v) ||
    !keys(v, ['requestId', 'method', 'state', 'recovery', 'targetId', 'operation']) ||
    !base(v) ||
    !(v['targetId'] === null || text(v['targetId']))
  )
    return false;
  const op = v['operation'];
  return (
    op === null ||
    (validServiceOwnerOperation(op) &&
      op.method === v['method'] &&
      op.input.requestId === v['requestId'] &&
      op.input.connectionId === v['targetId'])
  );
}
export function isLocalServiceOwnerOperationsPage(
  v: unknown,
): v is LocalServiceOwnerOperationsPage {
  return (
    object(v) &&
    keys(v, ['items', 'next']) &&
    Array.isArray(v['items']) &&
    v['items'].length <= 100 &&
    Array.from(v['items']).every(isLocalServiceOwnerOperationItem) &&
    (v['next'] === null || text(v['next'])) &&
    bounded(v)
  );
}
export type {
  ServiceOwnerOperationsQuery as LocalServiceOwnerOperationsQuery,
  ServiceOwnerOperation as LocalServiceOwnerOperation,
  OwnerScopeGrant as LocalOwnerScopeGrant,
} from '@runnets/domain';
