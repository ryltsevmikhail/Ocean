import { expect, it } from 'vitest';
import { mapStream } from './stream.js';
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
const finish = (u: unknown = usage) =>
  frame({ model: 'deepseek-flash', choices: [{ delta: {}, finish_reason: 'stop' }], usage: u });
const DONE = 'data: [DONE]\n\n';
async function run(chunks: readonly string[], fail = false, expectedModel?: string) {
  const events = [];
  for await (const e of mapStream(
    (async function* () {
      yield* chunks;
      if (fail) throw Error('read failed');
    })(),
    expectedModel,
  ))
    events.push(e);
  return events;
}
it.each([
  [finish()],
  [frame({ choices: [{ delta: { content: 'x' } }] }), DONE],
  [finish(), 'data: [DONE]'],
])('requires finish and strictly framed DONE (%#)', async (...chunks) => {
  const events = await run(chunks);
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
  expect(events.some((e) => e.type === 'completed' || e.type === 'tool_call')).toBe(false);
});
it.each([undefined, { prompt_tokens: 5 }, { ...usage, total_tokens: 8 }])(
  'does not fabricate usage from absent/partial tuples (%#)',
  async (u) => {
    const events = await run([finish(u === undefined ? null : u), DONE]);
    expect(events.at(-2)).toEqual({
      type: 'usage_evidence',
      evidence: { kind: 'unavailable', reason: 'not_reported' },
    });
    expect(events.at(-1)?.type).toBe('completed');
  },
);
it('qualifies documented final finish+usage and tolerated additional metadata', async () => {
  for (const chunks of [
    [finish(), DONE],
    [frame({ choices: [], usage }), finish(), DONE],
  ]) {
    const events = await run(chunks);
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    expect(events.at(-1)?.type).toBe('completed');
  }
});
it.each(['JSON', 'vendor', 'tool', 'decreasing', 'iterator'])(
  'preserves actual usage after %s failure',
  async (kind) => {
    const tail =
      kind === 'JSON'
        ? 'data: nope\n\n'
        : kind === 'vendor'
          ? frame({ error: { message: 'failed' } })
          : kind === 'tool'
            ? frame({ choices: [{ delta: { tool_calls: [{ index: -1 }] } }] })
            : kind === 'decreasing'
              ? frame({
                  choices: [],
                  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
                })
              : '';
    const events = await run([finish(), tail], kind === 'iterator');
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    expect(events.some((e) => e.type === 'usage_evidence' || e.type === 'completed')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
  },
);

it('checks present model identity while retaining absent-model compatibility', async () => {
  const absent = frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage });
  expect((await run([absent, DONE], false, 'deepseek-flash')).at(-1)?.type).toBe('completed');
  const mismatch = frame({
    model: 'wrong',
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  });
  const events = await run([mismatch, DONE], false, 'deepseek-flash');
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
  expect(events.some((e) => e.type === 'tool_call' || e.type === 'completed')).toBe(false);
});
