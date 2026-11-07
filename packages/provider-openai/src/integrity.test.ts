import { expect, it } from 'vitest';
import { createOpenAIProvider } from './index.js';
import { collect, fake, request, frame, choice, usageFrame, DONE } from '../test-fixtures/http.js';
const run = (chunks: readonly string[]) =>
  collect(
    createOpenAIProvider({ apiKey: 'fixture', httpClient: fake(chunks).http }).stream(request()),
  );
const candidate = {
  index: 0,
  id: 'call',
  type: 'function',
  function: { name: 'write_file', arguments: '{"path":"file.txt","content":"x"}' },
};
it.each([
  [
    { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    { prompt_tokens: 4, completion_tokens: 20, total_tokens: 24 },
  ],
  [
    { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
    { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  ],
])(
  'retains the larger crossed observed debit while refusing tools/completion (%#)',
  async (first, next) => {
    const events = await run([
      choice({ tool_calls: [candidate] }),
      frame({ model: 'gpt-5.6-terra', choices: [], usage: first }),
      frame({ model: 'gpt-5.6-terra', choices: [], usage: next }),
      choice({}, 'tool_calls'),
      DONE,
    ]);
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: next.prompt_tokens,
          outputTokens: next.completion_tokens,
          totalTokens: next.total_tokens,
        },
      },
    ]);
    expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
  },
);
it.each([
  { function: 42 },
  { function: null },
  { function: [] },
  { function: 'bad' },
  { type: 'custom' },
  { type: null },
  { type: 42 },
])('rejects present malformed tool wire fields after a complete candidate (%j)', async (bad) => {
  const events = await run([
    usageFrame,
    choice({ tool_calls: [candidate] }),
    choice({ tool_calls: [{ index: 0, ...bad }] }, 'tool_calls'),
    DONE,
  ]);
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
  ]);
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
});
it('allows omitted fragment discriminators and an empty function object without validating argument JSON', async () => {
  const events = await run([
    choice({
      tool_calls: [{ ...candidate, function: { name: 'write_file', arguments: '{malformed' } }],
    }),
    choice({ tool_calls: [{ index: 0 }, { index: 0, function: {} }] }),
    choice({}, 'tool_calls'),
    usageFrame,
    DONE,
  ]);
  expect(events).toContainEqual({
    type: 'tool_call',
    call: { id: 'call', name: 'write_file', arguments: '{malformed' },
  });
  expect(events.at(-1)?.type).toBe('completed');
});
