import {
  parseSse,
  SseError,
  retainTokenUsage,
  type CompletionStopReason,
  type ProviderEvent,
  type TokenUsage,
} from '@runnets/provider-core';
import { asRecord, readUsage } from './wire.js';
import { ToolAssembler } from './tool-assembler.js';
import { malformedStream, errorFromException } from './errors.js';
import { OPENAI_MODELS } from './profile.js';

function stopReason(raw: string): CompletionStopReason {
  return raw === 'stop' || raw === 'length' || raw === 'content_filter' || raw === 'tool_calls'
    ? raw
    : 'unknown';
}

/** No tools escape until finish, strict framing and DONE jointly prove completion. */
export async function* mapStream(
  chunks: AsyncIterable<string>,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  let usage: TokenUsage | null = null;
  let finish: string | null = null;
  let done = false;
  let calls: ReturnType<ToolAssembler['finish']> = [];
  const tools = new ToolAssembler();
  try {
    for await (const frame of parseSse(chunks, {
      requireTerminatedFrames: true,
      maxFrameBytes: 262144,
    })) {
      if (signal?.aborted === true) throw signal.reason;
      if (frame.data === '[DONE]') {
        done = true;
        break;
      }
      if (frame.data.trim() === '') continue;
      let record: Record<string, unknown> | null;
      try {
        record = asRecord(JSON.parse(frame.data) as unknown);
      } catch {
        throw malformedStream();
      }
      if (record === null) throw malformedStream();
      const next = readUsage(record['usage']);
      if (next !== null) {
        try {
          usage = retainTokenUsage(usage, next);
        } catch {
          throw malformedStream();
        }
      }
      if (record['error'] !== undefined || record['model'] !== OPENAI_MODELS[0])
        throw malformedStream();
      const choices = record['choices'];
      if (!Array.isArray(choices) || choices.length > 1) throw malformedStream();
      if (choices.length === 0) continue; // usage-only chunk can follow finish
      const choice = asRecord(choices[0]);
      if (choice === null || choice['index'] !== 0) throw malformedStream();
      const delta = asRecord(choice['delta']);
      if (delta === null || finish !== null) throw malformedStream();
      try {
        tools.accept(record);
      } catch {
        throw malformedStream();
      }
      const content = delta['content'];
      if (content !== undefined && content !== null && typeof content !== 'string')
        throw malformedStream();
      if (typeof content === 'string' && content !== '')
        yield { type: 'text_delta', text: content };
      const reason = choice['finish_reason'];
      if (reason !== undefined && reason !== null) {
        if (typeof reason !== 'string' || reason.length === 0) throw malformedStream();
        finish = reason;
      }
    }
    if (!done || finish === null) throw malformedStream();
    try {
      calls = tools.finish();
    } catch {
      throw malformedStream();
    }
  } catch (error) {
    if (usage !== null) yield { type: 'usage', usage };
    else yield { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'interrupted' } };
    yield {
      type: 'error',
      error:
        signal?.aborted === true
          ? errorFromException(error, signal)
          : error instanceof SseError
            ? malformedStream()
            : errorFromException(error, signal),
    };
    return;
  }
  for (const call of calls) yield { type: 'tool_call', call };
  if (usage !== null) yield { type: 'usage', usage };
  else yield { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } };
  yield { type: 'completed', stopReason: stopReason(finish), rawStopReason: finish.slice(0, 64) };
}
