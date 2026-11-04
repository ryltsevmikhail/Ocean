import { describe, expect, it } from 'vitest';

import {
  ProviderError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ModelRequest,
  type ProviderEvent,
} from '@runnets/provider-core';

import { DEEPSEEK_MODEL_INFO, DeepSeekProvider } from './provider.js';
import { buildRequestBody, serializedBodyBytes } from './wire.js';

const TINY = {
  'image/jpeg':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ABRzT+//2Q==',
  'image/png':
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEXAOSuU7d9gAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'image/gif': 'R0lGODlhAwACAPAAACeuYAAAACH5BAAAAAAALAAAAAADAAIAAAIChF8AOw==',
  'image/webp':
    'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoDAAIAAgA0JaACdLoB+AADsAD+8Skv/d5v2837eb/ho/+B/WK0qAAA',
} as const;
const SHA = {
  'image/jpeg': 'd78caf30dc3500fb548444e500cc199ec3afa082f8011721d524c1657d657dc0',
  'image/png': 'f850872af004a636a65dbcb1a6ea62c6e9d228867f03048ced70c546a9b19987',
  'image/gif': 'ede5d797a588560fa7ffacde26e054f4e9a619d2a087400ed7947b4ebe051d48',
  'image/webp': 'd9ae5f8cd50720bd612a52bb4ceb72b6233709d624003507b22839a378f4c12f',
} as const;
type MediaType = keyof typeof TINY;

interface FakeHttp extends HttpClient {
  readonly calls: HttpRequest[];
}
function fakeHttp(): FakeHttp {
  const calls: HttpRequest[] = [];
  return {
    calls,
    async send(request: HttpRequest): Promise<HttpResponse> {
      calls.push(request);
      return {
        status: 200,
        ok: true,
        text: async () => '',
        stream: () =>
          (async function* () {
            yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n';
            yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
            yield 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n';
            yield 'data: [DONE]\n\n';
          })(),
      };
    },
  };
}
function imagePart(mediaType: MediaType) {
  return {
    type: 'image' as const,
    mediaType,
    bytes: new Uint8Array(Buffer.from(TINY[mediaType], 'base64')),
    attachmentId: '12345678-1234-4123-8123-123456789abc',
    roomId: 'room-1',
    sha256: SHA[mediaType],
    width: 3,
    height: 2,
  };
}
function request(content: ModelRequest['messages'][number]['content']): ModelRequest {
  return {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content }],
  };
}
async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const provider = (http: HttpClient) =>
  new DeepSeekProvider({ apiKey: 'sk-fixture-only', httpClient: http });

describe('DeepSeek wire content', () => {
  it('keeps legacy string content byte-identical', () => {
    const legacy: ModelRequest = {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: 'ответ', reasoning: 'думал' },
        { role: 'tool', content: 'result', toolCallId: 'call-1' },
      ],
    };
    const body = JSON.parse(buildRequestBody(legacy)) as {
      messages: readonly { content: unknown }[];
    };
    expect(body.messages.map((message) => message.content)).toEqual([
      'system',
      'привет',
      'ответ',
      'result',
    ]);
  });

  it('maps verified image parts to data-URL image_url parts for user messages only', () => {
    for (const mediaType of Object.keys(TINY) as MediaType[]) {
      const body = JSON.parse(
        buildRequestBody(
          request([{ type: 'text', text: 'Что на изображении?' }, imagePart(mediaType)]),
        ),
      ) as {
        messages: readonly {
          role: string;
          content: readonly { type: string; text?: string; image_url?: { url: string } }[];
        }[];
      };
      const content = body.messages[0]!.content;
      expect(body.messages[0]!.role).toBe('user');
      expect(content[0]).toEqual({ type: 'text', text: 'Что на изображении?' });
      expect(content[1]).toMatchObject({ type: 'image_url' });
      const url = content[1]!.image_url!.url;
      const prefix = `data:${mediaType};base64,`;
      expect(url.startsWith(prefix)).toBe(true);
      const payload = Buffer.from(url.slice(prefix.length), 'base64');
      expect(payload.equals(Buffer.from(TINY[mediaType], 'base64'))).toBe(true);
      expect(payload.toString('base64')).toBe(TINY[mediaType]);
      expect(JSON.stringify(body)).not.toContain('[Ocean Desktop attachments');
    }
  });

  it('counts the exact serialized UTF-8 body, including Cyrillic and base64 overhead', () => {
    const textOnly = request('Привет');
    expect(serializedBodyBytes(textOnly)).toBe(
      Buffer.byteLength(buildRequestBody(textOnly), 'utf8'),
    );
    expect(serializedBodyBytes(textOnly)).toBeGreaterThan(
      Buffer.byteLength(buildRequestBody(request('Hello!')), 'utf8') - 1,
    );
    const withImage = request([{ type: 'text', text: 'Привет' }, imagePart('image/png')]);
    const imageBase64 = TINY['image/png'].length;
    expect(serializedBodyBytes(withImage) - serializedBodyBytes(request('Привет'))).toBeGreaterThan(
      imageBase64,
    );
  });

  it('publishes per-model input capabilities and one request serializer', () => {
    const adapter = provider(fakeHttp());
    expect(adapter.modelInfo).toEqual(DEEPSEEK_MODEL_INFO);
    expect(DEEPSEEK_MODEL_INFO).toEqual([
      { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
      { id: 'deepseek-v4-pro', inputModalities: ['text'] },
    ]);
    const withImage = request([imagePart('image/png')]);
    expect(adapter.requestBytes(withImage)).toBe(Buffer.byteLength(buildRequestBody(withImage)));
  });
});

describe('DeepSeek image guards', () => {
  it('refuses image parts outside user messages without any HTTP request', async () => {
    for (const role of ['system', 'assistant', 'tool'] as const) {
      const http = fakeHttp();
      const events = await collect(
        provider(http).stream({
          model: 'deepseek-flash',
          messages: [{ role, content: [imagePart('image/png')] }],
        }),
      );
      expect(http.calls).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ type: 'error' });
      const failure = events.find((event) => event.type === 'error');
      expect(failure).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });

  it('refuses a serialized body above 48 MiB before any network call', async () => {
    const http = fakeHttp();
    const huge = {
      ...imagePart('image/png'),
      bytes: new Uint8Array(36 * 1024 * 1024).fill(7),
    };
    const events = await collect(
      provider(http).stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: [huge] }],
      }),
    );
    expect(http.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'invalid_request', retryable: false },
    });
    expect(events[0]).toMatchObject({ error: { message: 'request_too_large' } });
  });

  it('sends the exact expected bytes for a real image request', async () => {
    const http = fakeHttp();
    const requestBody = request([{ type: 'text', text: 'diagram' }, imagePart('image/webp')]);
    const events = await collect(provider(http).stream(requestBody));
    expect(http.calls).toHaveLength(1);
    const sent = http.calls[0]!.body ?? '';
    expect(sent).toContain('data:image/webp;base64,' + TINY['image/webp']);
    expect(sent).not.toContain('[Ocean Desktop attachments');
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    expect(serializedBodyBytes(requestBody)).toBe(Buffer.byteLength(sent, 'utf8'));
  });
});

describe('DeepSeek provider error identity', () => {
  it('keeps ProviderError classification for refusal events', async () => {
    const http = fakeHttp();
    const events = await collect(
      provider(http).stream({
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: [imagePart('image/png')] }],
      }),
    );
    const failure = events.find((event) => event.type === 'error');
    expect(failure?.type === 'error' && failure.error).toBeInstanceOf(ProviderError);
  });
});
