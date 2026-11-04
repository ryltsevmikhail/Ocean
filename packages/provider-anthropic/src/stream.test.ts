import { expect, it } from 'vitest';
import { createAnthropicProvider } from './index.js';
import {
  collect,
  fake,
  request,
  start,
  delta,
  stop,
  text,
  tool,
  frame,
  terminals,
} from '../test-fixtures/http.js';
import type { ProviderEvent } from '@runnets/provider-core';
const run = async (chunks: readonly string[]) =>
  collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: fake(chunks).http }).stream(request()),
  );
const usage = (events: readonly ProviderEvent[]) =>
  events.filter((e) => e.type === 'usage' || e.type === 'usage_evidence');
it('streams text and normalizes cumulative cache counts once without TTL double counting', async () => {
  const events = await run([
    start(),
    frame('ping'),
    ': keepalive\nid: ignored\nretry: 50\n\n',
    ...text,
    delta(),
    stop,
  ]);
  expect(events).toEqual([
    { type: 'text_delta', text: 'hello' },
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 7, totalTokens: 207 } },
    { type: 'completed', stopReason: 'stop', rawStopReason: 'end_turn' },
  ]);
});
it('assembles indexed fragmented object calls only after terminal validation', async () => {
  const chunks = [
    start(),
    frame('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'one', name: 'read_file', input: {} },
    }),
    frame('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    }),
    frame('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"a"}' },
    }),
    frame('content_block_stop', { index: 0 }),
    ...tool(1, 'two', '{}'),
    delta('tool_use'),
    stop,
  ];
  const events = await run(chunks.flatMap((chunk) => [...chunk]));
  expect(events.filter((e) => e.type === 'tool_call')).toEqual([
    { type: 'tool_call', call: { id: 'one', name: 'read_file', arguments: '{"path":"a"}' } },
    { type: 'tool_call', call: { id: 'two', name: 'read_file', arguments: '{}' } },
  ]);
  expect(terminals(events)).toEqual([
    { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_use' },
  ]);
});
it.each([
  ['end_turn', 'stop'],
  ['stop_sequence', 'stop'],
  ['max_tokens', 'length'],
  ['model_context_window_exceeded', 'length'],
  ['refusal', 'content_filter'],
])('normalizes terminal %s', async (raw, normalized) => {
  expect(terminals(await run([start(), delta(raw), stop]))).toEqual([
    { type: 'completed', stopReason: normalized, rawStopReason: raw },
  ]);
});
it('replaces initial output 1 with final output 15', async () => {
  expect(usage(await run([start(), delta('end_turn', { output_tokens: 15 }), stop]))).toEqual([
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 15, totalTokens: 215 } },
  ]);
});
it.each([undefined, {}, { output_tokens: -1 }, { output_tokens: 1.5 }, { output_tokens: null }])(
  'keeps known terminal with deficient final accounting %#',
  async (u) => {
    const final = frame('message_delta', {
      delta: { stop_reason: 'end_turn' },
      ...(u === undefined ? {} : { usage: u }),
    });
    const events = await run([start(), delta(null, { output_tokens: 4 }), final, stop]);
    expect(usage(events)).toEqual([
      { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } },
    ]);
    expect(terminals(events)).toEqual([
      { type: 'completed', stopReason: 'stop', rawStopReason: 'end_turn' },
    ]);
  },
);
it('does not fabricate absent cache fields as zero', async () => {
  expect(usage(await run([start({ input_tokens: 5, output_tokens: 1 }), delta(), stop]))).toEqual([
    { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } },
  ]);
});
it('accepts explicit zero input/cache usage and cumulative later inputs', async () => {
  expect(
    usage(
      await run([
        start({
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        }),
        delta('end_turn', { input_tokens: 2, output_tokens: 3 }),
        stop,
      ]),
    ),
  ).toEqual([{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }]);
});
it.each([[start()], [start(), ...text], [start(), delta(null, { output_tokens: 4 })]])(
  'does not publish prefix counts on interruption %#',
  async (...chunks) => {
    const events = await run(chunks);
    expect(usage(events)).toEqual([
      { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'interrupted' } },
    ]);
    expect(terminals(events)).toMatchObject([{ type: 'error', error: { dispatch: 'unknown' } }]);
  },
);
it('retains qualified final usage on missing message_stop without exposing tools', async () => {
  const events = await run([start(), ...tool(), delta('tool_use')]);
  expect(usage(events)).toEqual([
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 7, totalTokens: 207 } },
  ]);
  expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  expect(terminals(events)).toMatchObject([{ type: 'error', error: { dispatch: 'unknown' } }]);
});
it.each([
  [start(), ...tool(), delta('tool_use'), stop.trimEnd()],
  [start(), ...tool(), delta('pause_turn'), stop],
  [start(), ...tool(), delta('future_reason'), stop],
  [start(), ...tool(), delta('end_turn'), stop],
  [start(), delta('tool_use'), stop],
  [start(), ...tool(0, 'same'), ...tool(1, 'same'), delta('tool_use'), stop],
  [start(), ...tool(0, 'call', '[]'), delta('tool_use'), stop],
  [start(), ...tool(0, 'call', '{'), delta('tool_use'), stop],
  [
    start(),
    frame('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: 'secret', signature: 'signed' },
    }),
    delta(),
    stop,
  ],
  [
    start(),
    frame('content_block_start', {
      index: 0,
      content_block: { type: 'server_tool_use', id: 's', name: 'execute', input: {} },
    }),
    delta(),
    stop,
  ],
  [
    start(),
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'orphan' } }),
    delta(),
    stop,
  ],
  [start(), ...text.slice(0, 2), delta(), stop],
  [start(), start(), delta(), stop],
  [start(), frame('message_delta', { type: 'ping' }), delta(), stop],
  [start(), 'event: message_delta\ndata: {\n\n', stop],
  [start(), frame('error', { error: { type: 'overloaded_error', message: 'sensitive' } })],
])('refuses malformed, unsupported or incomplete execution evidence %#', async (...chunks) => {
  const events = await run(chunks);
  expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  expect(terminals(events)).toMatchObject([{ type: 'error', error: { dispatch: 'unknown' } }]);
  expect(JSON.stringify(events)).not.toContain('sensitive');
});
it('retains observed qualified usage rather than componentwise maxima on later contradiction', async () => {
  const events = await run([
    start(),
    delta(),
    delta('end_turn', { input_tokens: 300, output_tokens: 2 }),
    stop,
  ]);
  expect(usage(events)).toEqual([
    { type: 'usage', usage: { inputTokens: 400, outputTokens: 2, totalTokens: 402 } },
  ]);
  expect(terminals(events)[0]?.type).toBe('error');
});
it('bounds native frame and aggregate tool assembly', async () => {
  for (const chunks of [
    [start(), `: ${'x'.repeat(262144)}\n\n`],
    [start(), ...tool(0, 'c', `{"x":"${'x'.repeat(131072)}"}`), delta('tool_use'), stop],
  ]) {
    expect(terminals(await run(chunks))[0]?.type).toBe('error');
  }
});
