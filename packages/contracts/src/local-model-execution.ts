import type { LocalRunQuery } from './local-runtime-turns.js';
export type LocalModelExecutionIdentity =
  | { readonly source: 'host'; readonly providerId: string; readonly modelId: string }
  | {
      readonly source: 'connection';
      readonly providerId: string;
      readonly modelId: string;
      readonly connectionId: string;
      readonly connectionRevision: number;
      readonly botProfileVersion: number;
      readonly kind: 'cloud' | 'local';
    };
export interface LocalModelTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
export type LocalModelUsageEvidence =
  | { readonly kind: 'actual'; readonly tokens: LocalModelTokens }
  | { readonly kind: 'estimated'; readonly tokens: LocalModelTokens; readonly estimator: string }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'unsupported' | 'not_reported' | 'interrupted';
    };
export type LocalModelCompletionEvidence =
  | {
      readonly kind: 'terminal';
      readonly stopReason:
        'stop' | 'length' | 'content_filter' | 'tool_calls' | 'cancelled' | 'unknown';
    }
  | { readonly kind: 'rejected' | 'not_sent' | 'unknown' };
export interface LocalModelExecutionProjection {
  readonly identity: LocalModelExecutionIdentity;
  readonly startedRequests: number;
  readonly lastRequest: {
    readonly attemptId: string;
    readonly ordinal: number;
    readonly startedAt: string;
    readonly settlement: {
      readonly finishedAt: string;
      readonly completion: LocalModelCompletionEvidence;
      readonly usage: LocalModelUsageEvidence;
    } | null;
  };
  readonly usage: {
    readonly scope: 'recorded_model_requests';
    readonly knownTokensScope: 'run_ledger_including_legacy_prefix';
    readonly knownTokens: number;
    readonly estimatedTokens: number;
    readonly unavailableRequests: number;
    readonly requestCounts: {
      readonly actual: number;
      readonly estimated: number;
      readonly unavailable: number;
      readonly pending: number;
    } | null;
    readonly completeness: 'complete' | 'incomplete' | 'unknown';
  };
}
export interface LocalRunModelExecution extends LocalRunQuery {
  readonly version: 1;
  readonly runVersion: number;
  readonly execution: LocalModelExecutionProjection | null;
}
