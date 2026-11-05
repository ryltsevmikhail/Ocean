import type {
  EffectResourceScope,
  OwnerScopeGrant,
  OwnerGrantReference,
  ServiceJson,
  ServiceConnection,
  ServiceToolDefinition,
  ServiceCatalogSnapshot,
  ToolEffectAdmission,
} from '@runnets/domain';
import type { ServiceAuthorityStorePort } from './service-authority-ports.js';
import type { ServicePluginInvokeOutcome } from './service-plugin-transport.js';
export interface ServiceCallRequest extends Readonly<OwnerScopeGrant['subject']> {
  readonly connectionId: string;
  readonly catalogId: string;
  readonly tool: string;
  readonly arguments: ServiceJson;
  readonly grantReference: OwnerGrantReference;
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}
export interface ServiceCallInvocation {
  readonly connection: ServiceConnection;
  readonly catalogId: string;
  readonly definition: ServiceToolDefinition;
  readonly arguments: ServiceJson;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  /** Invoke synchronously immediately before sending; false forbids I/O. */
  authorizeDispatch(): boolean;
}
export interface ServiceCallTransportPort {
  invoke(input: ServiceCallInvocation): Promise<ServicePluginInvokeOutcome>;
}
export interface ServiceCallAdmissionOptions {
  readonly store: ServiceAuthorityStorePort;
  readonly transport: ServiceCallTransportPort;
  readonly restored: boolean;
  readonly now: () => number;
  readonly deadlineMs?: number;
  /** Trusted host classification for the exact route/tool/arguments. Only return resolved, enforced canonical resources. Unknown aliases or unenforced selectors require global scope. */
  readonly classify?: (
    connection: ServiceConnection,
    tool: ServiceToolDefinition,
    args: ServiceJson,
  ) => {
    scope: EffectResourceScope;
    effectKind: ToolEffectAdmission['effectKind'];
    /** Optional qualified immutable GitHub.com numeric IDs, keyed by lowercase owner/repo. */
    githubRepositoryIds?: Readonly<Record<string, string>>;
  };
  /** Host evidence of unchanged account across precisely these credential bindings. */
  readonly credentialContinuous?: (
    connection: ServiceConnection,
    baseline: ServiceCatalogSnapshot,
  ) => boolean;
}
export interface ServiceCallResult {
  readonly code: string;
  readonly outcome: ServicePluginInvokeOutcome | null;
}
