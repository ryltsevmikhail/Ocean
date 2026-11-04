import { expect, it } from 'vitest';
import { createAnthropicProvider } from './index.js';
import { collect, fake, request } from '../test-fixtures/http.js';
import type { ChatMessage, ImagePart } from '@runnets/provider-core';

it('sends native system, ordered base64 image, client tools and correlated grouped results with exact byte count', async () => {
  const f = fake();
  const provider = createAnthropicProvider({ apiKey: 'fixture-key', httpClient: f.http });
  const image: ImagePart = {
    type: 'image',
    mediaType: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
    attachmentId: 'attachment',
    roomId: 'room',
    sha256: 'hash',
    width: 1,
    height: 1,
  };
  const r = request({
    temperature: 0.4,
    maxTokens: 128000,
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    messages: [
      { role: 'system', content: 'instruction' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'look' }, image, { type: 'text', text: 'now' }],
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'one', name: 'read_file', arguments: '{"path":"a"}' },
          { id: 'two', name: 'read_file', arguments: '{}' },
        ],
      },
      { role: 'tool', content: 'A', toolCallId: 'one' },
      { role: 'tool', content: 'B', toolCallId: 'two' },
      { role: 'user', content: 'continue' },
    ],
  });
  await collect(provider.stream(r));
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    redirect: 'manual',
    headers: { 'x-api-key': 'fixture-key', 'anthropic-version': '2026-10-21' },
  });
  const body = f.calls[0]!.body!;
  expect(provider.requestBytes!(r)).toBe(Buffer.byteLength(body));
  expect(JSON.parse(body)).toEqual({
    model: 'claude-haiku-5-5',
    max_tokens: 128000,
    stream: true,
    thinking: { type: 'disabled' },
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: 'instruction' }],
    tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
          { type: 'text', text: 'now' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'one', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 'two', name: 'read_file', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'one', content: 'A' },
          { type: 'tool_result', tool_use_id: 'two', content: 'B' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
  });
});
it.each([undefined, 1, 4097, 128000])(
  'preserves output allowance %s without unsupported fields',
  async (maxTokens) => {
    const f = fake();
    const r = request(maxTokens === undefined ? {} : { maxTokens });
    await collect(createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(r));
    const body = JSON.parse(f.calls[0]!.body!) as Record<string, unknown>;
    expect(body.max_tokens).toBe(maxTokens ?? 4096);
    for (const key of ['temperature', 'top_p', 'top_k', 'fallback', 'betas'])
      expect(body).not.toHaveProperty(key);
  },
);
it.each([0, -1, 128001, 1.1, NaN, Infinity])(
  'rejects invalid allowance %s before send',
  async (maxTokens) => {
    const f = fake();
    const p = createAnthropicProvider({ apiKey: 'key', httpClient: f.http });
    expect(await collect(p.stream(request({ maxTokens })))).toMatchObject([
      { type: 'error', error: { code: 'invalid_request', dispatch: 'not_sent', retryable: false } },
    ]);
    expect(f.calls).toHaveLength(0);
  },
);
const call = { id: 'one', name: 'read_file', arguments: '{}' };
it.each<readonly ChatMessage[]>([
  [{ role: 'assistant', content: '', reasoning: 'signed reasoning cannot roundtrip' }],
  [{ role: 'tool', content: 'orphan', toolCallId: 'missing' }],
  [
    { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'user', content: 'missing result' },
  ],
  [{ role: 'assistant', content: '', toolCalls: [call, call] }],
  [{ role: 'assistant', content: '', toolCalls: [{ ...call, arguments: '[]' }] }],
  [{ role: 'assistant', content: '', toolCalls: [{ ...call, arguments: '{' }] }],
  [
    { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', content: 'wrong', toolCallId: 'two' },
  ],
  [
    { role: 'user', content: 'u' },
    { role: 'system', content: 'late' },
  ],
])('refuses incompatible history %# before dispatch', async (...messages) => {
  const f = fake();
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request({ messages })),
  );
  expect(events).toMatchObject([{ type: 'error', error: { dispatch: 'not_sent' } }]);
  expect(f.calls).toHaveLength(0);
});
it('refuses unsupported model before send', async () => {
  const f = fake();
  expect(
    await collect(
      createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(
        request({ model: 'thinking-model' }),
      ),
    ),
  ).toMatchObject([{ type: 'error', error: { dispatch: 'not_sent' } }]);
  expect(f.calls).toHaveLength(0);
});
it('accepts the engine empty reasoning field during native tool continuation', async () => {
  const f = fake();
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(
      request({
        messages: [
          { role: 'user', content: 'read' },
          {
            role: 'assistant',
            content: '',
            reasoning: '',
            toolCalls: [{ id: 'one', name: 'read_file', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 'one', content: 'result' },
        ],
      }),
    ),
  );
  expect(events.at(-1)?.type).toBe('completed');
  expect(f.calls).toHaveLength(1);
  expect(JSON.parse(f.calls[0]!.body!)).not.toHaveProperty('reasoning');
});
