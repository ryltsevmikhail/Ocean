import {
  ProviderError,
  parseNdjson,
  validateTokenUsage,
  type ProviderEvent,
  type ToolCall,
  type TokenUsage,
} from '@runnets/provider-core';
import { MODEL, object, assertLocalOrigin } from './profile.js';
/** Tools are candidates until the complete framed stream and terminal reason validate. */
export async function* mapLocalStream(
  chunks: AsyncIterable<string>,
  priorIds: readonly string[] = [],
  signal?: AbortSignal,
  tools = true,
): AsyncIterable<ProviderEvent> {
  const calls: ToolCall[] = [],
    names = new Set<string>(),
    ids = new Set(priorIds);
  let nextId = 0;
  let done = false,
    reason = '',
    usage: TokenUsage | null = null;
  try {
    for await (const v of parseNdjson(chunks)) {
      if (done) throw Error('data after done');
      assertLocalOrigin(v);
      if (v['model'] !== undefined && v['model'] !== MODEL) throw Error('local identity drift');
      if (v['error'] !== undefined || typeof v['done'] !== 'boolean')
        throw Error('local stream error');
      const m = v['message'] === undefined ? null : object(v['message']);
      if (v['message'] !== undefined && (!m || m['role'] !== 'assistant'))
        throw Error('invalid local message');
      if (m) {
        if (m['thinking'] !== undefined && m['thinking'] !== '')
          throw Error('unexpected local thinking');
        if (m['content'] !== undefined && typeof m['content'] !== 'string')
          throw Error('invalid local text');
        if (typeof m['content'] === 'string' && m['content'] !== '')
          yield { type: 'text_delta', text: m['content'] };
        if (m['tool_calls'] !== undefined) {
          const candidates = m['tool_calls'];
          if (
            !Array.isArray(candidates) ||
            candidates.length > 128 ||
            (!tools && candidates.length > 0)
          )
            throw Error('invalid local tools');
          for (const raw of candidates) {
            const f = object(object(raw)?.['function']),
              name = f?.['name'],
              args = object(f?.['arguments']);
            if (
              typeof name !== 'string' ||
              !name ||
              name.length > 128 ||
              !args ||
              names.has(name) ||
              calls.length >= 128
            )
              throw Error('ambiguous local tools');
            while (ids.has(`local_${nextId}`)) nextId++;
            const id = `local_${nextId++}`;
            ids.add(id);
            names.add(name);
            calls.push({ id, name, arguments: JSON.stringify(args) });
          }
        }
      }
      if (v['done']) {
        done = true;
        const input = v['prompt_eval_count'],
          output = v['eval_count'];
        usage = validateTokenUsage({
          inputTokens: input,
          outputTokens: output,
          totalTokens:
            typeof input === 'number' && typeof output === 'number' ? input + output : undefined,
        });
        reason = typeof v['done_reason'] === 'string' ? v['done_reason'] : '';
      }
    }
    if (!done || !['stop', 'length'].includes(reason) || (reason === 'length' && calls.length > 0))
      throw Error('incomplete local stream');
  } catch (error) {
    const code = signal?.aborted
      ? signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
        ? 'timeout'
        : 'cancelled'
      : error instanceof ProviderError
        ? error.code
        : 'unknown';
    yield {
      type: 'usage_evidence',
      evidence: usage
        ? { kind: 'actual', tokens: usage }
        : { kind: 'unavailable', reason: 'interrupted' },
    };
    yield {
      type: 'error',
      error: new ProviderError(code, 'invalid or incomplete local stream', {
        dispatch: 'unknown',
        retryable: false,
      }),
    };
    return;
  }
  yield {
    type: 'usage_evidence',
    evidence: usage
      ? { kind: 'actual', tokens: usage }
      : { kind: 'unavailable', reason: 'not_reported' },
  };
  for (const call of calls) yield { type: 'tool_call', call };
  yield {
    type: 'completed',
    stopReason: reason === 'length' ? 'length' : calls.length ? 'tool_calls' : 'stop',
    rawStopReason: reason,
  };
}
