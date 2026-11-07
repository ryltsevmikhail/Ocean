/**
 * Provider port.
 *
 * A provider turns one normalized request into a stream of normalized events.
 * Provider SDKs, wire formats and auth live in adapter packages; nothing here
 * knows about a specific vendor, and the runtime consumes only this contract.
 */

import { emptyUsageObservation, observeUsage } from './usage-evidence.js';
import type { CompletionStopReason, ImageMediaType, ModelUsageEvidence } from '@runnets/domain';

/** Provider-neutral text content. Legacy messages keep a plain string instead. */
export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Runtime-resolved image bytes. Never a host path, URL, marker or base64 DTO:
 * the resolver verifies persisted authority and hashes before constructing this.
 */
export interface ImagePart {
  readonly type: 'image';
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
  readonly attachmentId: string;
  readonly roomId: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export type ContentPart = TextPart | ImagePart;
/** Only `user` messages may carry image parts. */
export type ChatContent = string | readonly ContentPart[];

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: ChatContent;
  readonly reasoning?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Modalities an adapter documents for one model. Unknown metadata stays conservative. */
export type ModelInputModality = 'text' | 'image';
export interface ProviderModelInfo {
  readonly id: string;
  readonly inputModalities: readonly ModelInputModality[];
}

export interface ModelRequest {
  /** Trusted runtime authority, checked immediately before actual inference dispatch. */
  readonly authorizeDispatch?: () => boolean;
  readonly tools?: readonly ToolDefinition[];
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type {
  CompletionStopReason,
  ModelActivationSnapshot,
  ModelExecutionIdentity,
  ModelExecutionLimits,
  ModelUsageEvidence,
  ModelCompletionEvidence,
  StartModelRequestPayload,
  SettleModelRequestPayload,
  ModelExecutionState,
} from '@runnets/domain';

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'invalid_request'
  | 'cancelled'
  | 'unknown';

/** A normalized failure: the runtime never sees vendor error shapes. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly dispatch: 'not_sent' | 'rejected' | 'unknown';

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly status?: number | null;
      readonly dispatch?: 'not_sent' | 'rejected' | 'unknown';
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable =
      options.retryable ??
      (code === 'rate_limit' || code === 'server' || code === 'network' || code === 'timeout');
    this.status = options.status ?? null;
    this.dispatch = options.dispatch ?? 'unknown';
  }
}

export type ProviderEvent =
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'usage_evidence'; readonly evidence: ModelUsageEvidence }
  | {
      readonly type: 'completed';
      readonly stopReason: CompletionStopReason;
      /** Vendor finish reason, preserved so an unknown value stays auditable. */
      readonly rawStopReason: string | null;
    }
  | { readonly type: 'error'; readonly error: ProviderError };

/**
 * What an adapter can do. A host must reject a request that needs an
 * unsupported capability before dispatch instead of degrading silently.
 */
export interface ProviderCapabilities {
  readonly toolCalls?: boolean;
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly usage: boolean;
}

/**
 * One model provider. `stream` must yield deltas as they arrive and finish with
 * exactly one `completed` or `error` event; a consumer that stops early must
 * abort through `request.signal`.
 */
export interface ProviderPort {
  readonly id: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  /** Documented per-model input capabilities; absent metadata never claims images. */
  readonly modelInfo?: readonly ProviderModelInfo[];
  /**
   * Exact UTF-8 size of the adapter's serialized request body. The application
   * pre-check and the adapter hard gate share the adapter's one serializer, so an
   * image-capable provider must implement it.
   */
  requestBytes?(request: ModelRequest): number;
  stream(request: ModelRequest): AsyncIterable<ProviderEvent>;
}

/** Accumulate a provider stream into the assistant text plus usage. */
export interface CollectedReply {
  readonly text: string;
  readonly reasoning: string;
  readonly usage: TokenUsage | null;
  readonly usageEvidence: ModelUsageEvidence | null;
  readonly stopReason: CompletionStopReason | null;
  readonly error: ProviderError | null;
}

export async function collectReply(
  events: AsyncIterable<ProviderEvent>,
  onDelta?: (text: string) => void,
): Promise<CollectedReply> {
  let text = '';
  let reasoning = '';
  let observed = emptyUsageObservation();
  let stopReason: CompletionStopReason | null = null;
  let error: ProviderError | null = null;

  for await (const event of events) {
    switch (event.type) {
      case 'tool_call':
        break;
      case 'text_delta':
        text += event.text;
        onDelta?.(event.text);
        break;
      case 'reasoning_delta':
        reasoning += event.text;
        break;
      case 'usage':
        observed = observeUsage(observed, { kind: 'actual', tokens: event.usage });
        break;
      case 'usage_evidence':
        observed = observeUsage(observed, event.evidence);
        break;
      case 'completed':
        stopReason = event.stopReason;
        break;
      case 'error':
        error = event.error;
        break;
    }
  }

  if (observed.conflict) {
    error ??= new ProviderError('unknown', 'conflicting model usage reports');
    stopReason = null;
  }
  if (observed.positiveActual && error !== null && error.dispatch !== 'unknown') {
    error = new ProviderError(error.code, error.message, {
      retryable: error.retryable,
      status: error.status,
      dispatch: 'unknown',
    });
  }
  const usageEvidence = observed.evidence;
  const usage = usageEvidence?.kind === 'actual' ? usageEvidence.tokens : null;
  return { text, reasoning, usage, usageEvidence, stopReason, error };
}
