import { createFetchHttpClient, type FetchLike, type HttpClient } from '@runnets/provider-core';
/** Test-only canonical request router; accepts only a private fixture origin. */
export function fixtureProviderHttpClient(
  localOrigin: string,
  fetchImpl: FetchLike = globalThis.fetch,
): HttpClient {
  const origin = new URL(localOrigin);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw Error('private fixture origin required');
  return createFetchHttpClient(async (url, init) => {
    const canonical =
      (init.method === 'GET' && url === 'https://api.deepseek.com/models') ||
      (init.method === 'POST' && url === 'https://api.deepseek.com/chat/completions');
    if (!canonical) throw Error('unexpected canonical provider request');
    return fetchImpl(new URL(new URL(url).pathname, origin).href, { ...init, redirect: 'error' });
  });
}
