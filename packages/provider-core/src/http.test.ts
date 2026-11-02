import { describe, expect, it } from 'vitest';

import { createFetchHttpClient } from './http.js';
import { ProviderError } from './provider.js';

function responseWith(chunks: readonly Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status });
}

const encoder = new TextEncoder();

async function readStream(response: { stream(): AsyncIterable<string> }): Promise<string> {
  let text = '';
  for await (const chunk of response.stream()) text += chunk;
  return text;
}

describe('createFetchHttpClient', () => {
  it('sends a POST with the given url, headers and body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createFetchHttpClient(async (url, init) => {
      calls.push({ url, init });
      return responseWith([encoder.encode('ok')]);
    });

    await client.send({
      url: 'https://example.test/v1',
      headers: { authorization: 'Bearer test' },
      body: '{"hello":true}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/v1');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer test' });
    expect(calls[0]?.init.body).toBe('{"hello":true}');
  });

  it('reports status and body text for a non-streamed read', async () => {
    const client = createFetchHttpClient(async () =>
      responseWith([encoder.encode('{"error":"bad"}')], 400),
    );

    const response = await client.send({ url: 'https://example.test', headers: {}, body: '{}' });

    expect(response.status).toBe(400);
    expect(response.ok).toBe(false);
    await expect(response.text()).resolves.toBe('{"error":"bad"}');
  });

  it('decodes multi-byte characters split across stream chunks', async () => {
    const bytes = encoder.encode('héllo 🌍');
    const client = createFetchHttpClient(async () =>
      responseWith([bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)]),
    );

    const response = await client.send({ url: 'https://example.test', headers: {}, body: '{}' });

    await expect(readStream(response)).resolves.toBe('héllo 🌍');
  });

  it('yields nothing when the response has no body', async () => {
    const client = createFetchHttpClient(async () => new Response(null, { status: 204 }));

    const response = await client.send({ url: 'https://example.test', headers: {}, body: '{}' });

    await expect(readStream(response)).resolves.toBe('');
  });

  it('maps a network rejection to a retryable network error', async () => {
    const client = createFetchHttpClient(async () => {
      throw new TypeError('fetch failed');
    });

    const error = await client
      .send({ url: 'https://example.test', headers: {}, body: '{}' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'network', retryable: true, message: 'fetch failed' });
  });

  it('maps an abort to a cancelled error', async () => {
    const client = createFetchHttpClient(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const error = await client
      .send({ url: 'https://example.test', headers: {}, body: '{}' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('maps a timeout to a timeout error', async () => {
    const client = createFetchHttpClient(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });

    const error = await client
      .send({ url: 'https://example.test', headers: {}, body: '{}' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('forwards the abort signal to fetch', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const client = createFetchHttpClient(async (_url, init) => {
      received = init.signal ?? undefined;
      return responseWith([encoder.encode('ok')]);
    });

    await client.send({
      url: 'https://example.test',
      headers: {},
      body: '{}',
      signal: controller.signal,
    });

    expect(received).toBe(controller.signal);
  });
});
