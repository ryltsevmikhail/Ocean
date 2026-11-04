/**
 * Admission request/result contracts for one plugin invocation.
 *
 * Plain application types only: the transport, the journal and the durable
 * operation row all speak these shapes.
 */

import type { PluginAdapterIdentity } from '@runnets/domain';
import type {
  ServicePluginInvokeOutcome,
  ServicePluginJson,
  ServicePluginTransportPort,
} from './service-plugin-transport.js';
import type { PluginAdmissionStorePort } from './plugin-ports.js';
import type { PluginCredentialReferencePort } from './plugin-ports.js';

export interface PluginCallClaim {
  readonly invocationId: string;
  readonly taskRunId: string;
  readonly attemptId: string;
}

export interface PluginCallRequest {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly grantId: string;
  readonly tool: string;
  readonly arguments: ServicePluginJson;
  readonly claim: PluginCallClaim;
}

export interface PluginCallResult {
  readonly admitted: boolean;
  /** `admitted` or one stable lowercase denial code. */
  readonly code: string;
  readonly invocationId: string;
  readonly grantId: string | null;
  readonly connectionGeneration: number | null;
  readonly schemaDigest: string | null;
  readonly outcome: ServicePluginInvokeOutcome | null;
  readonly settled: boolean;
  /** Bounded, explicit-truncation model-visible text for an observed result. */
  readonly summary: string | null;
}

export interface PluginCallAdmissionOptions {
  readonly store: PluginAdmissionStorePort;
  readonly transport: ServicePluginTransportPort;
  readonly credentials: PluginCredentialReferencePort;
  readonly adapter: PluginAdapterIdentity;
  readonly now: () => string;
  readonly sha256: (text: string) => string;
  readonly deadlineMs?: number;
  readonly maxRequestBytes?: number;
}
