/**
 * Suite-wide outbound-network guard.
 *
 * Task 5 qualification must make zero real service requests. Tests may use
 * loopback fixtures (127.0.0.1/localhost/::1) but any attempt to reach another
 * host is recorded and rejected before bytes leave the process. The source and
 * process vitest presets load this file; the spawned process-suite children use
 * loopback/unix sockets only and are covered by their own assertions.
 */
import { afterAll } from 'vitest';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const attempts: string[] = [];
const original = globalThis.fetch;
type FetchInput = Parameters<typeof original>[0];

function hostOf(input: FetchInput): string | null {
  try {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === 'object' && 'url' in input
            ? String(input.url)
            : '';
    return url === '' ? null : new URL(url).hostname;
  } catch {
    return null;
  }
}

globalThis.fetch = (input: FetchInput, init?: RequestInit): Promise<Response> => {
  const host = hostOf(input);
  if (host === null || !LOOPBACK.has(host)) {
    const url = typeof input === 'string' ? input : String(input);
    attempts.push(url);
    return Promise.reject(
      Object.assign(new Error('test_network_blocked: ' + url), { code: 'test_network_blocked' }),
    );
  }
  return original(input, init);
};

Object.defineProperty(globalThis, '__oceanBlockedFetches', {
  value: attempts,
  configurable: true,
  enumerable: false,
  writable: false,
});

// Every source-suite test file must finish with zero attempted external egress.
// The guard's own self-test clears its deliberate attempt after asserting it.
afterAll(() => {
  if (attempts.length > 0)
    throw new Error('external network attempted in tests: ' + attempts.join(','));
});
