/**
 * DeepSeek stream mapping.
 *
 * Consumes SSE frames and yields normalized provider events. The stream ends
 * with exactly one `completed` or `error` event; the `[DONE]` sentinel is a
 * terminator, not an event, and usage is emitted before completion.
 */

import {
  ProviderError,
  parseSse,
  SseError,
  retainTokenUsage,
  type CompletionStopReason,
  type ProviderEvent,
  type TokenUsage,
} from '@runnets/provider-core';

import { ToolAssembler } from './tool-assembler.js';
import { errorFromStreamPayload, errorFromException } from './errors.js';
import { asRecord, readDelta, readUsage } from './wire.js';

const DONE_SENTINEL = '[DONE]';

function malformedStream(): ProviderError {
  return new ProviderError('server', 'malformed DeepSeek stream event', { retryable: false });
}

/** Map a vendor finish reason to the normalized stop reason; unknown values fail safe. */
export function toStopReason(finishReason: string): CompletionStopReason {
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
      return 'tool_calls';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** Vendors occasionally send long reasons; keep the raw value bounded. */
function boundRawReason(finishReason: string): string {
  return finishReason.length > 64 ? finishReason.slice(0, 64) : finishReason;
}

/** Translate the DeepSeek SSE stream into normalized provider events. */
export async function* mapStream(
  chunks: AsyncIterable<string>,
  expectedModel?: string,
): AsyncIterable<ProviderEvent> {
  let stopReason: CompletionStopReason | null = null;
  let rawStopReason: string | null = null;
  let usage: TokenUsage | null = null;
  let frames = 0;
  let terminated = false;
  let calls: ReturnType<ToolAssembler['finish']> = [];
  const tools = new ToolAssembler();

  try {
    for await (const frame of parseSse(chunks, {
      requireTerminatedFrames: true,
      maxFrameBytes: 262144,
    })) {
      if (frame.data === DONE_SENTINEL) {
        terminated = true;
        break;
      }
      if (frame.data.trim() === '') continue;
      frames += 1;
      let record: Record<string, unknown> | null;
      try {
        record = asRecord(JSON.parse(frame.data) as unknown);
      } catch {
        throw malformedStream();
      }
      if (record === null) throw malformedStream();
      const chunkUsage = readUsage(record['usage']);
      if (chunkUsage !== null) {
        const retained = retainTokenUsage(usage, chunkUsage);
        usage = retained.usage;
        if (retained.conflict) throw malformedStream();
      }
      if (
        expectedModel !== undefined &&
        record['model'] !== undefined &&
        record['model'] !== expectedModel
      )
        throw malformedStream();
      if (record['error'] !== undefined) throw errorFromStreamPayload(record['error']);
      if (stopReason !== null) {
        const choices = record['choices'];
        if (!Array.isArray(choices) || choices.length !== 0) throw malformedStream();
      }
      try {
        tools.accept(record);
      } catch {
        throw malformedStream();
      }
      const delta = readDelta(record);
      if (delta === null) continue;
      if (delta.reasoning !== null) yield { type: 'reasoning_delta', text: delta.reasoning };
      if (delta.content !== null) yield { type: 'text_delta', text: delta.content };
      if (delta.finishReason !== null) {
        stopReason = toStopReason(delta.finishReason);
        rawStopReason = boundRawReason(delta.finishReason);
      }
    }
    if (frames === 0)
      throw new ProviderError('server', 'empty DeepSeek stream', { retryable: false });
    if (stopReason === null || !terminated)
      throw new ProviderError('server', 'incomplete DeepSeek stream', { retryable: false });
    try {
      calls = tools.finish();
    } catch {
      throw malformedStream();
    }
  } catch (error) {
    // Preserve transport exceptions for the lifecycle's timeout/cancellation mapping.
    const failure =
      error instanceof SseError
        ? malformedStream()
        : errorFromException(error, { cancelled: null, timeout: null });
    if (usage !== null) yield { type: 'usage', usage };
    else yield { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'interrupted' } };
    if (
      !(error instanceof ProviderError) &&
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    )
      throw error;
    yield { type: 'error', error: failure };
    return;
  }
  for (const call of calls) yield { type: 'tool_call', call };
  if (usage !== null) yield { type: 'usage', usage };
  else yield { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } };
  yield { type: 'completed', stopReason, rawStopReason };
}
