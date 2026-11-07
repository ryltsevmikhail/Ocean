import type { TokenUsagePayload } from './events.js';
import type { BotModelBinding } from './model-binding.js';
import type { ModelCapabilities } from './model-capabilities.js';
export type { BotModelBinding } from './model-binding.js';
export type { ModelCapabilities } from './model-capabilities.js';

export type CompletionStopReason =
  'stop' | 'length' | 'content_filter' | 'tool_calls' | 'cancelled' | 'unknown';
export interface ModelExecutionLimits {
  readonly maxModelRequests: number;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
}
export type ModelExecutionIdentity =
  | (BotModelBinding & {
      readonly source: 'connection';
      readonly providerId: string;
      readonly connectionRevision: number;
      readonly botProfileVersion: number;
      readonly kind: 'cloud' | 'local';
      readonly endpoint: string;
      readonly auth: 'api_key' | 'none';
      readonly artifactDigest: string | null;
      readonly backendVersion: string | null;
    })
  | { readonly source: 'host'; readonly providerId: string; readonly modelId: string };
export interface ModelActivationSnapshot {
  readonly version: 1;
  readonly identity: ModelExecutionIdentity;
  readonly capabilities: ModelCapabilities;
  readonly limits: ModelExecutionLimits;
  readonly admittedAt: string;
  readonly deadlineAt: string;
}
export type ModelUsageEvidence =
  | { readonly kind: 'actual'; readonly tokens: TokenUsagePayload }
  | { readonly kind: 'estimated'; readonly tokens: TokenUsagePayload; readonly estimator: string }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'unsupported' | 'not_reported' | 'interrupted';
    };
export type ModelCompletionEvidence =
  | { readonly kind: 'terminal'; readonly stopReason: CompletionStopReason }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'not_sent' }
  | { readonly kind: 'unknown' };
export interface StartModelRequestPayload {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly activation: ModelActivationSnapshot;
  readonly startedAt: string;
}
export interface SettleModelRequestPayload {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly finishedAt: string;
  readonly completion: ModelCompletionEvidence;
  readonly usage: ModelUsageEvidence;
}
export interface ModelExecutionState {
  readonly activation: ModelActivationSnapshot;
  readonly startedRequests: number;
  readonly lastRequest: {
    readonly attemptId: string;
    readonly ordinal: number;
    readonly startedAt: string;
    readonly settlement: SettleModelRequestPayload | null;
  };
  readonly usage: {
    readonly knownTokens: number;
    readonly estimatedTokens: number;
    readonly unavailableRequests: number;
  };
}
