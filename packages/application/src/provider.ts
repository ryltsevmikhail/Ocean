/**
 * Provider port.
 *
 * A provider turns one normalized request into a stream of normalized events.
 * Provider SDKs, wire formats and auth live in adapter packages; nothing here
 * knows about a specific vendor, and the runtime consumes only this contract.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
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

export type CompletionStopReason =
  'stop' | 'length' | 'content_filter' | 'tool_calls' | 'cancelled' | 'unknown';

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

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly status?: number | null } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable =
      options.retryable ??
      (code === 'rate_limit' || code === 'server' || code === 'network' || code === 'timeout');
    this.status = options.status ?? null;
  }
}

export type ProviderEvent =
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
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
  /**
   * Per-model capabilities the adapter documents (for example image input).
   * Optional: a provider without metadata declares no confirmed extra modality.
   */
  readonly modelInfo?: readonly ProviderModelInfo[];
  readonly capabilities: ProviderCapabilities;
  stream(request: ModelRequest): AsyncIterable<ProviderEvent>;
}

/** Accumulate a provider stream into the assistant text plus usage. */
export interface CollectedReply {
  readonly text: string;
  readonly reasoning: string;
  readonly usage: TokenUsage | null;
  readonly stopReason: CompletionStopReason | null;
  readonly error: ProviderError | null;
}

export async function collectReply(
  events: AsyncIterable<ProviderEvent>,
  onDelta?: (text: string) => void,
): Promise<CollectedReply> {
  let text = '';
  let reasoning = '';
  let usage: TokenUsage | null = null;
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
        usage = event.usage;
        break;
      case 'completed':
        stopReason = event.stopReason;
        break;
      case 'error':
        error = event.error;
        break;
    }
  }

  return { text, reasoning, usage, stopReason, error };
}
