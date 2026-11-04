import { expect, it } from 'vitest';
import { createOpenAIProvider } from './index.js';
import { collect, fake, request } from '../test-fixtures/http.js';
it('maps exact image bytes, text, tools and correlated history without authority metadata', async () => {
  const { http, calls } = fake();
  const provider = createOpenAIProvider({ apiKey: 'key', httpClient: http });
  const r = request({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Привет' },
          {
            type: 'image',
            attachmentId: 'private-attachment',
            roomId: 'private-room',
            sha256: 'private-hash',
            width: 1,
            height: 1,
            mediaType: 'image/png',
            bytes: new Uint8Array([0, 255, 1]),
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        reasoning: 'private-vendor-history',
        toolCalls: [{ id: 'call', name: 'read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'call', content: 'result' },
    ],
    tools: [{ name: 'read', description: 'read text', parameters: { type: 'object' } }],
  });
  await collect(provider.stream(r));
  const body = JSON.parse(calls[0]!.body!);
  expect(body.messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Привет' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AP8B' } },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', content: 'result', tool_call_id: 'call' },
  ]);
  expect(body.tools).toEqual([
    {
      type: 'function',
      function: { name: 'read', description: 'read text', parameters: { type: 'object' } },
    },
  ]);
  expect(provider.requestBytes!(r)).toBe(Buffer.byteLength(calls[0]!.body!, 'utf8'));
});
it('refuses image roles outside user before send', async () => {
  const { http, calls } = fake();
  const events = await collect(
    createOpenAIProvider({ apiKey: 'key', httpClient: http }).stream(
      request({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'image',
                attachmentId: 'private-attachment',
                roomId: 'private-room',
                sha256: 'private-hash',
                width: 1,
                height: 1,
                mediaType: 'image/png',
                bytes: new Uint8Array([1]),
              },
            ],
          },
        ],
      }),
    ),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'invalid_request', dispatch: 'not_sent' },
  });
  expect(calls).toHaveLength(0);
});
