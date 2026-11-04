import { expect, it } from 'vitest';
import { fixtureProviderHttpClient } from '../../test-fixtures/provider-http.js';

it('asserts canonical GET/POST URLs and sends only to the private loopback fixture', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = fixtureProviderHttpClient('http://127.0.0.1:12345', async (url, init) => {
    requests.push({ url, init });
    return new Response('ok');
  });
  const signal = new AbortController().signal;
  for (const [method, path] of [
    ['GET', '/models'],
    ['POST', '/chat/completions'],
  ] as const)
    await client.send({
      method,
      url: 'https://api.deepseek.com' + path,
      headers: {},
      signal,
      ...(method === 'POST' ? { body: 'fixture' } : {}),
    });
  expect(requests.map((r) => r.url)).toEqual([
    'http://127.0.0.1:12345/models',
    'http://127.0.0.1:12345/chat/completions',
  ]);
  expect(requests[1]?.init).toMatchObject({
    method: 'POST',
    body: 'fixture',
    signal,
    redirect: 'error',
  });
  for (const url of ['https://other.invalid/models', 'https://api.deepseek.com/models?extra=1'])
    await expect(client.send({ url, method: 'GET', headers: {} })).rejects.toThrow();
  await expect(
    client.send({ url: 'https://api.deepseek.com/models', method: 'POST', headers: {} }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(2);
});
it.each([
  'https://api.deepseek.com',
  'http://localhost:1234',
  'http://127.0.0.1:1234/path',
  'http://user@127.0.0.1:1234',
])('refuses a non-private fixture origin %s', (origin) => {
  expect(() => fixtureProviderHttpClient(origin)).toThrow();
});
