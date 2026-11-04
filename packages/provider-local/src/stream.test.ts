import { expect, it } from 'vitest';
import { collectReply, type ProviderEvent } from '@runnets/provider-core';
import { createLocalProvider } from './index.js';
import { endpoint, fixture, qualification, request } from '../test-fixtures/http.js';
async function run(values: unknown[]) {
  const f = fixture(
    {},
    values.map((v) => JSON.stringify(v) + '\n'),
  );
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: f.http,
  });
  const events: ProviderEvent[] = [];
  for await (const e of p.stream(request)) events.push(e);
  return events;
}
const tool = { function: { name: 'read', arguments: { path: 'one' } } };
const message = { role: 'assistant', content: '', tool_calls: [tool] };
const done = {
  model: 'qwen3:1.7b',
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 3,
  eval_count: 2,
};
it('buffers native tools until done and maps actual terminal usage', async () => {
  const events = await run([{ model: 'qwen3:1.7b', message, done: false }, done]);
  expect(events).toContainEqual({
    type: 'tool_call',
    call: { id: 'local_0', name: 'read', arguments: '{"path":"one"}' },
  });
  expect(events).toContainEqual({
    type: 'usage_evidence',
    evidence: { kind: 'actual', tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  });
  expect(events.at(-1)).toMatchObject({ type: 'completed', stopReason: 'tool_calls' });
});
it.each(
  [
    [{ message, done: false }],
    [{ message, done: false }, { error: 'sensitive backend detail' }],
    [
      { message, done: false },
      { ...done, done_reason: 'length' },
    ],
    [
      { message, done: false },
      { ...done, done_reason: 'unknown' },
    ],
    [
      { message, done: false },
      { ...done, model: 'wrong' },
    ],
    [{ message, done: false }, done, done],
    [{ message: { ...message, tool_calls: [tool, tool] }, done: false }, done],
    [{ message, done: false }, { message, done: false }, done],
  ].map((values) => ({ values })),
)(
  'never releases tools after incomplete, ambiguous or erroneous completion %j',
  async ({ values }) => {
    const events = await run(values);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
    expect(JSON.stringify(events)).not.toContain('sensitive backend detail');
  },
);
it('preserves terminal accounting on later framing failure, without completion or tools', async () => {
  const events = await run([done, { done: false }]);
  expect(events).toContainEqual({
    type: 'usage_evidence',
    evidence: { kind: 'actual', tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  });
  expect(events.at(-1)?.type).toBe('error');
  expect(events.some((e) => e.type === 'completed')).toBe(false);
});
it('roundtrips Ocean tool IDs into native tool_name and object arguments', async () => {
  const f = fixture();
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: f.http,
  });
  await collectReply(
    p.stream({
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          reasoning: '',
          toolCalls: [{ id: 'ocean-call', name: 'read', arguments: '{"path":"one"}' }],
        },
        { role: 'tool', toolCallId: 'ocean-call', content: 'result' },
      ],
    }),
  );
  expect(JSON.parse(f.requests[3]!.body!).messages.slice(1)).toEqual([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read', arguments: { path: 'one' } } }],
    },
    { role: 'tool', tool_name: 'read', content: 'result' },
  ]);
});
it.each(
  [
    [{ role: 'tool' as const, toolCallId: 'orphan', content: 'x' }],
    [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'x', name: 'read', arguments: '[]' }],
      },
    ],
    [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            bytes: new Uint8Array(),
            mediaType: 'image/png' as const,
            attachmentId: 'a',
            roomId: 'r',
            sha256: 'x',
            width: 1,
            height: 1,
          },
        ],
      },
    ],
  ].map((messages) => ({ messages })),
)('refuses unsupported wire content before all traffic %j', async ({ messages }) => {
  const f = fixture();
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: f.http,
  });
  expect((await collectReply(p.stream({ ...request, messages }))).error).toMatchObject({
    code: 'invalid_request',
    dispatch: 'not_sent',
  });
  expect(f.requests).toHaveLength(0);
});
it('emits fresh Ocean IDs across continuation rounds instead of replaying an earlier call', async () => {
  const f = fixture({}, [
    JSON.stringify({ message, done: false }) + '\n',
    JSON.stringify(done) + '\n',
  ]);
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: f.http,
  });
  const events: ProviderEvent[] = [];
  for await (const e of p.stream({
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'local_0', name: 'read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'local_0', content: 'first' },
    ],
  }))
    events.push(e);
  expect(events).toContainEqual({
    type: 'tool_call',
    call: { id: 'local_1', name: 'read', arguments: '{"path":"one"}' },
  });
});
