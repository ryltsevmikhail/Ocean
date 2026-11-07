import {
  parseSse,
  SseError,
  type CompletionStopReason,
  type ProviderEvent,
} from '@runnets/provider-core';
import { ANTHROPIC_MODELS } from './profile.js';
import { asRecord } from './wire.js';
import { ContentBlocks } from './blocks.js';
import { UsageAccumulator } from './usage.js';
import { errorFromException, malformedStream } from './errors.js';
function stopReason(raw: unknown): CompletionStopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      throw malformedStream();
  }
}
/** Completion requires strict framing and native lifecycle. Client tools are released last. */
export async function* mapStream(
  chunks: AsyncIterable<string>,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const blocks = new ContentBlocks(),
    usage = new UsageAccumulator();
  let started = false,
    done = false,
    finish: string | null = null;
  let reason: CompletionStopReason = 'unknown';
  try {
    for await (const frame of parseSse(chunks, {
      requireTerminatedFrames: true,
      maxFrameBytes: 262144,
    })) {
      if (signal?.aborted === true) throw signal.reason;
      let record: Record<string, unknown> | null;
      try {
        record = asRecord(JSON.parse(frame.data) as unknown);
      } catch {
        throw malformedStream();
      }
      if (record === null || frame.event !== record['type']) throw malformedStream();
      switch (record['type']) {
        case 'ping':
          if (Object.keys(record).some((key) => key !== 'type')) throw malformedStream();
          break;
        case 'message_start': {
          const message = asRecord(record['message']);
          if (
            started ||
            message?.['type'] !== 'message' ||
            message['role'] !== 'assistant' ||
            message['model'] !== ANTHROPIC_MODELS[0] ||
            !Array.isArray(message['content']) ||
            message['content'].length !== 0 ||
            (message['stop_reason'] !== undefined && message['stop_reason'] !== null)
          )
            throw malformedStream();
          started = true;
          usage.accept(message['usage'], false);
          break;
        }
        case 'content_block_start':
        case 'content_block_delta':
        case 'content_block_stop': {
          if (!started || finish !== null) throw malformedStream();
          let text: string | null = null;
          if (record['type'] === 'content_block_start') text = blocks.start(record);
          else if (record['type'] === 'content_block_delta') text = blocks.delta(record);
          else blocks.stop(record);
          if (text !== null && text !== '') yield { type: 'text_delta', text };
          break;
        }
        case 'message_delta': {
          if (!started || !blocks.closed) throw malformedStream();
          const delta = asRecord(record['delta']);
          if (delta === null) throw malformedStream();
          const raw = delta['stop_reason'];
          const repeatedTerminal = finish !== null;
          if (raw !== undefined && raw !== null) {
            reason = stopReason(raw);
            if (
              typeof raw !== 'string' ||
              (finish !== null && finish !== raw) ||
              blocks.calls.length > 0 !== (raw === 'tool_use')
            )
              throw malformedStream();
            finish = raw;
          } else if (finish !== null) throw malformedStream();
          usage.accept(record['usage'], raw !== undefined && raw !== null);
          if (repeatedTerminal) throw malformedStream();
          break;
        }
        case 'message_stop':
          if (!started || !blocks.closed || finish === null) throw malformedStream();
          done = true;
          break;
        default:
          throw malformedStream();
      }
      if (done) break;
    }
    if (!done) throw malformedStream();
  } catch (error) {
    if (usage.actual !== null) yield { type: 'usage', usage: usage.actual };
    else yield { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'interrupted' } };
    yield {
      type: 'error',
      error: error instanceof SseError ? malformedStream() : errorFromException(error, signal),
    };
    return;
  }
  for (const call of blocks.calls) yield { type: 'tool_call', call };
  if (usage.actual !== null) yield { type: 'usage', usage: usage.actual };
  else yield { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } };
  yield { type: 'completed', stopReason: reason, rawStopReason: finish };
}
