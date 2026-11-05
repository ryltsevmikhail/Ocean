import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
export function client(modern: boolean) {
  return new Client(
    { name: 'ocean', version: '0.0.0' },
    {
      capabilities: {},
      inputRequired: { autoFulfill: false },
      defaultCacheTtlMs: 0,
      versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
    },
  );
}
export function immutable(tool: Tool): Tool {
  const copy = structuredClone(tool);
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}
export const methodOf = (init?: RequestInit): string =>
  typeof init?.body === 'string'
    ? ((JSON.parse(init.body) as { method?: string }).method ?? 'response')
    : (init?.method ?? 'GET');
type WireFetch = NonNullable<
  NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>['fetch']
>;
export function httpTransport(url: URL, wire: WireFetch, headers: Record<string, string> = {}) {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers, redirect: 'error' },
    fetch: wire,
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
}
