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
  type CompletionStopReason,
  type ProviderEvent,
  type TokenUsage,
} from '@runnets/provider-core';

import { ToolAssembler } from './tool-assembler.js';
import { errorFromStreamPayload } from './errors.js';
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
export async function* mapStream(chunks: AsyncIterable<string>): AsyncIterable<ProviderEvent> {
  let stopReason: CompletionStopReason | null = null;
  let rawStopReason: string | null = null;
  let usage: TokenUsage | null = null;
  let frames = 0;
  let terminated = false;
  const tools = new ToolAssembler();

  for await (const frame of parseSse(chunks)) {
    if (frame.data === DONE_SENTINEL) {
      terminated = true;
      break;
    }
    if (frame.data.trim() === '') continue;
    frames += 1;

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data) as unknown;
    } catch {
      yield { type: 'error', error: malformedStream() };
      return;
    }
    const record = asRecord(payload);
    if (record === null) {
      yield { type: 'error', error: malformedStream() };
      return;
    }

    const wireError = record['error'];
    if (wireError !== undefined) {
      yield { type: 'error', error: errorFromStreamPayload(wireError) };
      return;
    }

    try {
      tools.accept(record);
    } catch {
      yield { type: 'error', error: malformedStream() };
      return;
    }
    const chunkUsage = readUsage(record['usage']);
    if (chunkUsage !== null) usage = chunkUsage;

    const delta = readDelta(record);
    if (delta === null) continue;
    if (delta.reasoning !== null) yield { type: 'reasoning_delta', text: delta.reasoning };
    if (delta.content !== null) yield { type: 'text_delta', text: delta.content };
    if (delta.finishReason !== null) {
      stopReason = toStopReason(delta.finishReason);
      rawStopReason = boundRawReason(delta.finishReason);
    }
  }

  if (frames === 0) {
    yield {
      type: 'error',
      error: new ProviderError('server', 'empty DeepSeek stream', { retryable: false }),
    };
    return;
  }

  // Neither a finish reason nor `[DONE]` means the connection dropped mid-stream:
  // a cut-off answer must never be reported as a completed turn, and partially
  // assembled tool calls must not reach the executor.
  if (stopReason === null && !terminated) {
    if (usage !== null) yield { type: 'usage', usage };
    yield {
      type: 'error',
      error: new ProviderError('server', 'incomplete DeepSeek stream', { retryable: false }),
    };
    return;
  }

  try {
    for (const call of tools.finish()) yield { type: 'tool_call', call };
  } catch {
    yield { type: 'error', error: malformedStream() };
    return;
  }
  if (usage !== null) yield { type: 'usage', usage };
  yield { type: 'completed', stopReason: stopReason ?? 'stop', rawStopReason };
}
