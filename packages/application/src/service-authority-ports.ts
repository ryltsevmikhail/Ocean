import type { ServiceOwnerReceipt } from './service-owner-receipt.js';
import type { ToolEffectAdmission, ToolEffectRecord, ToolEffectOutcome } from './tools.js';
import type { ServiceCallRequest } from './service-admission-types.js';
import type {
  ServiceOwnerOperationsQuery,
  OwnerScopeGrant,
  ServiceCatalogSnapshot,
  ServiceConnection,
  ServiceConnectionVersions,
} from '@runnets/domain';
/** Runtime-only storage; these operations grant no model-facing mutation capability. */
export interface ServiceAuthorityTransaction {
  listOwnerReceipts(
    ownerId: string,
    query: ServiceOwnerOperationsQuery,
  ): readonly ServiceOwnerReceipt[];
  ownerReceipt(requestId: string): ServiceOwnerReceipt | null;
  putOwnerReceipt(receipt: ServiceOwnerReceipt, expectedState: 'prepared' | null): boolean;
  participates(subject: OwnerScopeGrant['subject']): boolean;
  runMatches(request: ServiceCallRequest): boolean;
  grantCalls(run: string, grantId: string): number;
  claim(request: ServiceCallRequest, fingerprint: string, admission: ToolEffectAdmission): boolean;
  pending(): readonly ToolEffectRecord[];
  settle(request: ServiceCallRequest, outcome: Exclude<ToolEffectOutcome, 'started'>): void;
  connection(id: string): ServiceConnection | null;
  listConnections(query?: {
    readonly ownerId: string;
    readonly limit: number;
  }): readonly ServiceConnection[];
  /** null creates revision-1 axes; false is a stale/missing expected version. */
  putConnection(
    record: ServiceConnection,
    expectedVersions: ServiceConnectionVersions | null,
  ): boolean;
  catalog(id: string): ServiceCatalogSnapshot | null;
  /** Identical insertion is idempotent; conflicting immutable content throws. */
  putCatalog(record: ServiceCatalogSnapshot): boolean;
  publishCatalog(
    connectionId: string,
    expectedVersions: ServiceConnectionVersions,
    snapshotId: string,
  ): boolean;
  grant(id: string): OwnerScopeGrant | null;
  listGrants(query?: {
    readonly ownerId: string;
    readonly limit: number;
  }): readonly OwnerScopeGrant[];
  /** null creates revision 1; replacement must advance exactly one revision. */
  putGrant(record: OwnerScopeGrant, expectedRevision: number | null): boolean;
}
export interface ServiceAuthorityStorePort {
  /** Synchronous callback only; all operations share one immediate transaction. */
  atomic<T>(work: (tx: ServiceAuthorityTransaction) => T): T;
}
