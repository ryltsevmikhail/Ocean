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
import { emptyUsageObservation, observeUsage } from './usage-evidence.js';
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
  try {
    if (input.signal.aborted || input.authorizeModelDispatch?.() === false) return notSentRound();
  } catch {
    return notSentRound();
  }
  const bound = boundModelStream(
    input.signal,
    Math.min(remaining, activation.limits.requestTimeoutMs),
  );
  let iterator: AsyncIterator<ProviderEvent> | undefined;
  let text = '',
    reasoning = '';
  let usage = emptyUsageObservation();
  let stop: CompletionStopReason | null = null;
  let failure: ProviderError | null = null;
  let terminal = false;
  let inferenceObserved = false;
  let framingBroken = false;
  const calls: ToolCall[] = [];
  try {
    const events = input.provider.stream({
      ...(input.authorizeModelDispatch ? { authorizeDispatch: input.authorizeModelDispatch } : {}),
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
      bound.assertWithinDeadline();
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
          usage = observeUsage(usage, { kind: 'actual', tokens: event.usage });
          break;
        case 'usage_evidence':
          usage = observeUsage(usage, event.evidence);
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
    let observed = error;
    try {
      bound.assertWithinDeadline();
    } catch (expired) {
      observed = expired;
    }
    failure =
      observed instanceof ProviderError
        ? observed
        : new ProviderError('unknown', 'provider stream failed');
    // Even an earlier finish does not prove complete framing if next() fails.
    stop = null;
  } finally {
    bound.close(iterator);
  }
  if (usage.conflict) failure ??= new ProviderError('unknown', 'conflicting model usage reports');
  const completion: ModelCompletionEvidence =
    failure !== null
      ? {
          kind:
            inferenceObserved || framingBroken || usage.positiveActual || usage.conflict
              ? 'unknown'
              : failure.dispatch,
        }
      : stop === null
        ? { kind: 'unknown' }
        : { kind: 'terminal', stopReason: stop };
  const normalizedUsage: ModelUsageEvidence = usage.evidence ?? {
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
