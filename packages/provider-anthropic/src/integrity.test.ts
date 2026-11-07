import { expect, it } from 'vitest';
import { createAnthropicProvider } from './index.js';
import { collect, fake, request, start, delta, stop, tool, frame } from '../test-fixtures/http.js';
const run = (chunks: readonly string[]) =>
  collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: fake(chunks).http }).stream(request()),
  );
it('retains the greater crossed observed final tuple while refusing tools and completion', async () => {
  const events = await run([
    start(),
    ...tool(),
    delta('tool_use'),
    delta('tool_use', { input_tokens: 300, output_tokens: 2 }),
    stop,
  ]);
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 400, outputTokens: 2, totalTokens: 402 } },
  ]);
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
});
it.each([
  { cache_read_input_tokens: 'invalid' },
  { input_tokens: -1 },
  { cache_creation_input_tokens: Number.MAX_SAFE_INTEGER },
])(
  'does not silently reuse earlier input components after unusable cumulative evidence %#',
  async (bad) => {
    const events = await run([start(), delta(null, bad), delta(), stop]);
    expect(events.filter((e) => e.type === 'usage' || e.type === 'usage_evidence')).toEqual([
      { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
  },
);
it('refuses a repeated terminal delta even if usage remains monotonic', async () => {
  const events = await run([
    start(),
    ...tool(),
    delta('tool_use'),
    delta('tool_use', { output_tokens: 9 }),
    stop,
  ]);
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 9, totalTokens: 209 } },
  ]);
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
});
it('does not release a complete-looking tool before a stalled terminal frame is read', async () => {
  let released = false;
  const f = fake();
  f.http.send = async () => ({
    status: 200,
    ok: true,
    text: async () => '',
    async *stream() {
      for (const chunk of [start(), ...tool(), delta('tool_use')]) yield chunk;
      expect(released).toBe(false);
      yield stop;
    },
  });
  for await (const event of createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(
    request(),
  )) {
    if (event.type === 'tool_call') released = true;
  }
  expect(released).toBe(true);
});
it.each([
  { input: [] },
  { input: null },
  { input: 'bad' },
  { name: '' },
  { id: '' },
  { type: 'server_tool_use' },
])('refuses malformed native tool identity/input %#', async (bad) => {
  const events = await run([
    start(),
    frame('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'call', name: 'read_file', input: {}, ...bad },
    }),
    frame('content_block_stop', { index: 0 }),
    delta('tool_use'),
    stop,
  ]);
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
});
it('refuses output-bearing blocks after qualified final accounting while conserving actual', async () => {
  const events = await run([start(), delta(), ...tool(), stop]);
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 7, totalTokens: 207 } },
  ]);
  expect(events.at(-1)?.type).toBe('error');
});
