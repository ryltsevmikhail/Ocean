import { expect, it } from 'vitest';
import { mapStream } from './stream.js';
const model = 'deepseek-flash';
const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
const frame = (choices: unknown, u?: unknown) =>
  `data: ${JSON.stringify({ model, choices, ...(u === undefined ? {} : { usage: u }) })}\n\n`;
const choice = (delta: unknown = {}, finish_reason: string | null = null, u?: unknown) =>
  frame([{ delta, finish_reason }], u);
const DONE = 'data: [DONE]\n\n';
const candidate = {
  index: 0,
  id: 'call',
  type: 'function',
  function: { name: 'write_file', arguments: '{"path":"file.txt","content":"x"}' },
};
async function run(chunks: readonly string[]) {
  const result = [];
  for await (const event of mapStream(
    (async function* () {
      yield* chunks;
    })(),
    model,
  ))
    result.push(event);
  return result;
}
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
  'retains the larger crossed observed debit without granting terminal proof (%#)',
  async (first, next) => {
    const events = await run([
      choice({ tool_calls: [candidate] }),
      frame([], first),
      frame([], next),
      choice({}, 'tool_calls', next),
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
])(
  'rejects a present malformed tool fragment after complete identity/arguments (%j)',
  async (bad) => {
    const events = await run([
      frame([], usage),
      choice({ tool_calls: [candidate] }),
      choice({ tool_calls: [{ index: 0, ...bad }] }, 'tool_calls', usage),
      DONE,
    ]);
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
  },
);
it.each([
  choice({ tool_calls: [candidate] }),
  choice({ content: 'late' }),
  choice({ reasoning_content: 'late' }),
  choice({}, 'stop'),
  choice({}, 'tool_calls'),
])('rejects every further choice after the documented final choice (%#)', async (late) => {
  const events = await run([choice({}, 'tool_calls', usage), late, DONE]);
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
  ]);
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
});
it('retains choices-empty post-finish metadata compatibility with no synthetic tool output', async () => {
  const events = await run([choice({}, 'stop', usage), frame([], usage), DONE]);
  expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: 'completed', stopReason: 'stop' });
});
it('allows fragment omission/empty object and leaves malformed argument JSON to the engine', async () => {
  const events = await run([
    choice({
      tool_calls: [{ ...candidate, function: { name: 'write_file', arguments: '{malformed' } }],
    }),
    choice({ tool_calls: [{ index: 0 }, { index: 0, function: {} }] }),
    choice({}, 'tool_calls', usage),
    DONE,
  ]);
  expect(events).toContainEqual({
    type: 'tool_call',
    call: { id: 'call', name: 'write_file', arguments: '{malformed' },
  });
  expect(events.at(-1)?.type).toBe('completed');
});
