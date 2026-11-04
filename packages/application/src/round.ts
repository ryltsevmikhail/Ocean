import {
  ProviderError,
  type ChatMessage,
  type CompletionStopReason,
  type TokenUsage,
  type ToolCall,
  type ProviderEvent,
  type ModelUsageEvidence,
  type ModelCompletionEvidence,
} from './provider.js';
import { emitText } from './lifecycle.js';
import { boundModelStream } from './bounded-stream.js';
import { modelNow, normalizeModelActivation } from './model-activation.js';
import type { TurnInput } from './types.js';

export interface ModelRound {
  readonly text: string;
  readonly reasoning: string;
  readonly calls: readonly ToolCall[];
  readonly usage: TokenUsage | null;
  readonly usageEvidence: ModelUsageEvidence;
  readonly completion: ModelCompletionEvidence;
  readonly stop: CompletionStopReason | null;
  readonly failure: ProviderError | null;
}

function copyTokens(tokens: TokenUsage): TokenUsage {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
  };
}
function copyUsage(evidence: ModelUsageEvidence): ModelUsageEvidence {
  if (evidence.kind === 'unavailable') return { kind: evidence.kind, reason: evidence.reason };
  const tokens = copyTokens(evidence.tokens);
  return evidence.kind === 'actual'
    ? { kind: evidence.kind, tokens }
    : { kind: evidence.kind, tokens, estimator: evidence.estimator };
}

/** Explicit non-dispatch evidence for cancellation in the durable start/stream gap. */
export function notSentRound(): ModelRound {
  return {
    text: '',
    reasoning: '',
    calls: [],
    usage: null,
    usageEvidence: { kind: 'unavailable', reason: 'interrupted' },
    completion: { kind: 'not_sent' },
    stop: null,
    failure: null,
  };
}

/** Collect one fixed-bound dispatch; complete framing is independent of finish spelling. */
export async function modelRound(
  input: TurnInput,
  messages: readonly ChatMessage[],
): Promise<ModelRound> {
  if (input.provider === null) throw new Error('provider is required');
  if (input.signal.aborted) return notSentRound();
  const activation = input.activation ?? normalizeModelActivation(input);
  const remaining = Date.parse(activation.deadlineAt) - modelNow(input).getTime();
  if (remaining <= 0)
    return {
      ...notSentRound(),
      failure: new ProviderError('timeout', 'model turn deadline exceeded', {
        dispatch: 'not_sent',
      }),
    };
  const bound = boundModelStream(
    input.signal,
    Math.min(remaining, activation.limits.requestTimeoutMs),
  );
  let iterator: AsyncIterator<ProviderEvent> | undefined;
  let text = '',
    reasoning = '';
  let usageEvidence: ModelUsageEvidence | null = null;
  let stop: CompletionStopReason | null = null;
  let failure: ProviderError | null = null;
  let terminal = false;
  let inferenceObserved = false;
  let framingBroken = false;
  const calls: ToolCall[] = [];
  try {
    const events = input.provider.stream({
      model: input.model,
      messages: [...messages],
      signal: bound.signal,
      ...(input.tools === undefined ? {} : { tools: input.tools.definitions }),
      ...(activation.capabilities.maxOutputTokens === null
        ? {}
        : { maxTokens: activation.capabilities.maxOutputTokens }),
    });
    iterator = events[Symbol.asyncIterator]();
    for (;;) {
      const next = await bound.next(iterator);
      if (next.done === true) break;
      if (terminal) throw new ProviderError('unknown', 'provider emitted after terminal event');
      const event = next.value;
      switch (event.type) {
        case 'tool_call':
          inferenceObserved = true;
          calls.push({ ...event.call });
          break;
        case 'text_delta':
          inferenceObserved = true;
          text += event.text;
          emitText(input, 'agent_message_chunk', event.text);
          break;
        case 'reasoning_delta':
          inferenceObserved = true;
          reasoning += event.text;
          emitText(input, 'agent_thought_chunk', event.text);
          break;
        case 'usage':
          usageEvidence = { kind: 'actual', tokens: copyTokens(event.usage) };
          break;
        case 'usage_evidence':
          usageEvidence = copyUsage(event.evidence);
          break;
        case 'completed':
          stop = event.stopReason;
          terminal = true;
          break;
        case 'error':
          failure = event.error;
          terminal = true;
          break;
      }
      if (text.length + reasoning.length > 262144 || calls.length > 32)
        throw new ProviderError('invalid_request', 'model output limit exceeded');
    }
  } catch (error) {
    framingBroken = terminal;
    failure =
      error instanceof ProviderError
        ? error
        : new ProviderError('unknown', 'provider stream failed');
    // Even an earlier finish does not prove complete framing if next() fails.
    stop = null;
  } finally {
    bound.close(iterator);
  }
  const completion: ModelCompletionEvidence =
    failure !== null
      ? { kind: inferenceObserved || framingBroken ? 'unknown' : failure.dispatch }
      : stop === null
        ? { kind: 'unknown' }
        : { kind: 'terminal', stopReason: stop };
  const normalizedUsage: ModelUsageEvidence = usageEvidence ?? {
    kind: 'unavailable',
    reason:
      completion.kind === 'unknown'
        ? 'interrupted'
        : activation.capabilities.usage === 'unavailable'
          ? 'unsupported'
          : 'not_reported',
  };
  return {
    text,
    reasoning,
    calls,
    usage: normalizedUsage.kind === 'actual' ? normalizedUsage.tokens : null,
    usageEvidence: normalizedUsage,
    completion,
    stop,
    failure,
  };
}
