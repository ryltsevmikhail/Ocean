import {
  LOCAL_SERVICE_AUTHORITY,
  isLocalServiceConnectionRequest,
  isLocalServiceConnectionSetRequest,
  isLocalServiceGrantSetRequest,
  isLocalServiceGrantRevokeRequest,
  isLocalServiceReceiptQuery,
  isLocalServiceOwnerOperationsQuery,
  isLocalServiceQuery,
  isLocalServiceOwnerReceipt,
  isLocalServiceGrants,
  normalizeLocalServiceConnections,
  isLocalServiceOwnerOperationsPage,
  type LocalRuntimeIdentity,
  type LocalServiceConnectionRequest,
  type LocalServiceConnectionSetRequest,
  type LocalServiceGrantSetRequest,
  type LocalServiceGrantRevokeRequest,
  type LocalServiceConnectionView,
  type LocalOwnerScopeGrant,
  type LocalServiceOwnerReceipt,
  type LocalServiceOwnerOperationsQuery,
  type LocalServiceOwnerOperationsPage,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
type Send = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
export interface LocalServiceClient {
  serviceConnections(): Promise<readonly LocalServiceConnectionView[]>;
  serviceGrants(): Promise<readonly LocalOwnerScopeGrant[]>;
  serviceReceipt(query: { requestId: string }): Promise<LocalServiceOwnerReceipt | null>;
  setServiceConnection(
    request: LocalServiceConnectionSetRequest,
  ): Promise<LocalServiceOwnerReceipt>;
  disconnectServiceConnection(
    request: LocalServiceConnectionRequest,
  ): Promise<LocalServiceOwnerReceipt>;
  refreshServiceConnection(
    request: LocalServiceConnectionRequest,
  ): Promise<LocalServiceOwnerReceipt>;
  setOwnerScopeGrant(request: LocalServiceGrantSetRequest): Promise<LocalServiceOwnerReceipt>;
  revokeOwnerScopeGrant(request: LocalServiceGrantRevokeRequest): Promise<LocalServiceOwnerReceipt>;
  listServiceOwnerOperations(
    query: LocalServiceOwnerOperationsQuery,
  ): Promise<LocalServiceOwnerOperationsPage>;
}
/** One authenticated peer; support is a wire fact and never authority to execute an effect. */
export function localServiceClient(
  send: Send,
  identity: Pick<LocalRuntimeIdentity, 'capabilities'>,
): LocalServiceClient {
  function supported(method: string) {
    if (
      !identity.capabilities.includes(LOCAL_SERVICE_AUTHORITY) ||
      !identity.capabilities.includes(method)
    )
      throw Error(
        method === 'service.owner-operations'
          ? 'service_operations_upgrade_required'
          : 'service_runtime_upgrade_required',
      );
  }
  async function call<Q, R>(
    method: string,
    input: Q,
    valid: (v: unknown) => v is Q,
    response: (v: unknown) => v is R,
    matches: (r: R, q: Q) => boolean = () => true,
    timeout?: number,
  ): Promise<R> {
    supported(method);
    const q = structuredClone(validatedParams(input, valid));
    const r = timeout === undefined ? await send(method, q) : await send(method, q, timeout);
    if (!response(r) || !matches(r, q)) throw Error('invalid_frame');
    return r;
  }
  function receipt<Q extends { requestId: string }>(
    method: string,
    input: Q,
    valid: (v: unknown) => v is Q,
    target: (q: Q) => string,
    timeout?: number,
  ) {
    return call(
      method,
      input,
      valid,
      isLocalServiceOwnerReceipt,
      (r, q) =>
        r.requestId === q.requestId &&
        r.method === method &&
        (r.result === null ||
          ('connectionId' in r.result ? r.result.connectionId : r.result.id) === target(q)),
      timeout,
    );
  }
  return {
    async serviceConnections() {
      supported('service.connections');
      const result = normalizeLocalServiceConnections(
        await send('service.connections', validatedParams({}, isLocalServiceQuery)),
      );
      if (!result) throw Error('invalid_frame');
      return result;
    },
    serviceGrants: () => call('service.grants', {}, isLocalServiceQuery, isLocalServiceGrants),
    serviceReceipt: (q) =>
      call(
        'service.receipt',
        q,
        isLocalServiceReceiptQuery,
        (v): v is LocalServiceOwnerReceipt | null => v === null || isLocalServiceOwnerReceipt(v),
        (r, q) => r === null || r.requestId === q.requestId,
      ),
    setServiceConnection: (q) =>
      receipt(
        'service.connection-set',
        q,
        isLocalServiceConnectionSetRequest,
        (q) => q.connectionId,
      ),
    disconnectServiceConnection: (q) =>
      receipt(
        'service.connection-disconnect',
        q,
        isLocalServiceConnectionRequest,
        (q) => q.connectionId,
      ),
    refreshServiceConnection: (q) =>
      receipt(
        'service.connection-refresh',
        q,
        isLocalServiceConnectionRequest,
        (q) => q.connectionId,
        20_000,
      ),
    setOwnerScopeGrant: (q) =>
      receipt('service.grant-set', q, isLocalServiceGrantSetRequest, (q) => q.intent.id),
    revokeOwnerScopeGrant: (q) =>
      receipt('service.grant-revoke', q, isLocalServiceGrantRevokeRequest, (q) => q.grantId),
    listServiceOwnerOperations: (q) =>
      call(
        'service.owner-operations',
        q,
        isLocalServiceOwnerOperationsQuery,
        isLocalServiceOwnerOperationsPage,
        (r, q) => {
          if (r.items.length > (q.limit ?? 50)) return false;
          let after = q.after ?? '';
          for (const item of r.items) {
            if (
              Buffer.compare(Buffer.from(item.requestId), Buffer.from(after)) <= 0 ||
              (q.state !== undefined && item.state !== q.state)
            )
              return false;
            after = item.requestId;
          }
          return r.next === null || (r.items.length > 0 && r.next === after);
        },
      ),
  };
}
