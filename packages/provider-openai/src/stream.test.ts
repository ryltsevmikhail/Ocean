import { expect, it } from 'vitest';
import { createOpenAIProvider } from './index.js';
import {
  collect,
  fake,
  request,
  frame,
  choice,
  usageFrame,
  usage,
  DONE,
  terminals,
} from '../test-fixtures/http.js';
const run = async (chunks: readonly string[]) =>
  collect(createOpenAIProvider({ apiKey: 'key', httpClient: fake(chunks).http }).stream(request()));
it('handles split CRLF frames, indexed fragmented tools and post-finish usage', async () => {
  const wire = [
    choice({
      content: 'hi',
      tool_calls: [
        { index: 1, id: 'b', function: { name: 'second', arguments: '{' } },
        { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
      ],
    }),
    choice({ tool_calls: [{ index: 1, function: { arguments: '}' } }] }),
    choice({}, 'tool_calls'),
    usageFrame,
    DONE,
  ]
    .join('')
    .replaceAll('\n', '\r\n');
  const events = await run([...wire].map((c) => c));
  expect(events).toEqual([
    { type: 'text_delta', text: 'hi' },
    { type: 'tool_call', call: { id: 'a', name: 'first', arguments: '{}' } },
    { type: 'tool_call', call: { id: 'b', name: 'second', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
  ]);
});
it.each([
  [choice({}, 'stop')],
  [choice({ content: 'x' }), DONE],
  [choice({}, 'stop'), 'data: [DONE]'],
  [choice({}, 'stop'), 'data: {broken\n\n', DONE],
  [frame({ model: 'wrong', choices: [{ delta: {}, finish_reason: 'stop' }] }), DONE],
  [choice({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls'), DONE],
  [choice({}, 'stop'), 'data: ' + 'x'.repeat(262145)],
])('refuses incomplete/malformed completion without executable calls (%#)', async (...chunks) => {
  const events = await run(chunks);
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
  expect(terminals(events)).toHaveLength(1);
  expect(events.at(-2)).toEqual({
    type: 'usage_evidence',
    evidence: { kind: 'unavailable', reason: 'interrupted' },
  });
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'server', dispatch: 'unknown' },
  });
});
it.each([
  undefined,
  { prompt_tokens: 5 },
  { ...usage, total_tokens: 8 },
  { ...usage, completion_tokens: -1 },
])('keeps known completion with unavailable partial/missing accounting (%#)', async (badUsage) => {
  const events = await run([
    choice({}, 'stop'),
    frame({
      model: 'gpt-5.6-terra',
      choices: [],
      ...(badUsage === undefined ? {} : { usage: badUsage }),
    }),
    DONE,
  ]);
  expect(events.at(-2)).toEqual({
    type: 'usage_evidence',
    evidence: { kind: 'unavailable', reason: 'not_reported' },
  });
  expect(events.at(-1)?.type).toBe('completed');
});
it.each(['malformed', 'contradictory', 'incomplete-tool', 'vendor-error', 'missing-DONE'])(
  'retains actual usage on %s and emits it once',
  async (mode) => {
    const tail =
      mode === 'malformed'
        ? 'data: broken\n\n'
        : mode === 'contradictory'
          ? frame({
              model: 'gpt-5.6-terra',
              choices: [],
              usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            })
          : mode === 'incomplete-tool'
            ? choice({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls') +
              DONE
            : mode === 'vendor-error'
              ? frame({ error: { message: 'secret' } })
              : '';
    const events = await run([usageFrame, tail]);
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    expect(
      events.some(
        (e) => e.type === 'usage_evidence' || e.type === 'tool_call' || e.type === 'completed',
      ),
    ).toBe(false);
    expect(terminals(events)).toHaveLength(1);
  },
);
it('replaces cumulative reports, ignores equal tuples and bounds raw unknown reasons', async () => {
  const events = await run([
    usageFrame,
    usageFrame,
    frame({
      model: 'gpt-5.6-terra',
      choices: [],
      usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
    }),
    choice({}, 'x'.repeat(200)),
    DONE,
  ]);
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 } },
  ]);
  expect(events.at(-1)).toEqual({
    type: 'completed',
    stopReason: 'unknown',
    rawStopReason: 'x'.repeat(64),
  });
});
