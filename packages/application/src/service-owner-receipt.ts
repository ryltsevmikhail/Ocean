import type {
  ServiceOwnerOperation,
  OwnerScopeGrant,
  ServiceCatalogSnapshot,
  ServiceConnection,
  ServiceConnectionVersions,
} from '@runnets/domain';
export type ServiceOwnerResult = ServiceConnection | OwnerScopeGrant | ServiceCatalogSnapshot;
/** Prepared intent contains no credential bytes and never authorizes automatic retry. */
export interface ServiceOwnerReceipt {
  readonly requestId: string;
  readonly ownerId: string;
  readonly binding: string;
  readonly method: string;
  readonly state: 'prepared' | 'completed';
  readonly secretReference: string | null;
  readonly expectedVersions: ServiceConnectionVersions | null;
  readonly result: ServiceOwnerResult | null;
  readonly operation?: ServiceOwnerOperation;
}
export type ServiceOwnerReceiptView = Pick<
  ServiceOwnerReceipt,
  'requestId' | 'method' | 'state' | 'result'
> & { readonly recovery: 'explicit_recovery_required' | null };
export function serviceOwnerReceiptView(receipt: ServiceOwnerReceipt): ServiceOwnerReceiptView {
  return {
    requestId: receipt.requestId,
    method: receipt.method,
    state: receipt.state,
    result: structuredClone(receipt.result),
    recovery: receipt.state === 'prepared' ? 'explicit_recovery_required' : null,
  };
}
