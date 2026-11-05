import type { ServiceCatalogSnapshot, ServiceConnection } from '@runnets/domain';
import type { ServiceCallTransportPort } from '@runnets/application';

export type McpCatalogCandidate = Omit<ServiceCatalogSnapshot, 'id'>;
export interface McpDiscoveryOptions {
  readonly signal: AbortSignal;
  /** Relative budget for the entire discovery. */
  readonly deadlineMs: number;
  authorizeMetadata(): boolean;
}
export type McpCleanupEvidence = { readonly status: 'confirmed' | 'never_started' | 'unknown' };
export interface McpServiceTransportOptions {
  readonly protocol?: 'legacy' | '2026-07-28';
  /** Called only for the explicit reference of this exact connection generation. */
  resolveCredential?(reference: string, connection: ServiceConnection): string | null;
  /** Fixed, read-only GitHub issue profile, restricted to the qualified endpoint. */
  readonly githubIssueReadOnly?: boolean;
  readonly stdio?: {
    readonly profileRoot: string;
    readonly workspaces: Readonly<Record<string, string>>;
  };
  /** Optional trusted preparation; authorization always follows it at the writer. */
  prepareDispatch?(invocationId: string): void | Promise<void>;
  /** One hint per activated generation. The owner separately authorizes and joins refresh. */
  refreshNeeded?(connectionId: string): void;
}
export interface McpServiceTransport extends ServiceCallTransportPort {
  discover(
    connection: ServiceConnection,
    options: McpDiscoveryOptions,
  ): Promise<McpCatalogCandidate>;
  activate(
    candidate: McpCatalogCandidate,
    snapshot: ServiceCatalogSnapshot,
    confirmPublished: () => boolean,
  ): boolean;
  disposeCandidate(candidate: McpCatalogCandidate): Promise<McpCleanupEvidence>;
  close(): Promise<McpCleanupEvidence>;
}
