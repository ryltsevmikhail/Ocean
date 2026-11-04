import { describe, expect, it } from 'vitest';

interface GuardedGlobal {
  readonly __oceanBlockedFetches?: readonly string[];
}
const blocked = () => (globalThis as GuardedGlobal).__oceanBlockedFetches ?? [];

describe('suite no-network guard', () => {
  it('rejects and records a non-loopback fetch without network egress', async () => {
    const attempts = blocked() as string[];
    const before = attempts.length;
    await expect(fetch('https://api.githubcopilot.com/mcp/')).rejects.toThrow(
      'test_network_blocked',
    );
    expect(attempts.length).toBe(before + 1);
    expect(attempts.at(-1)).toContain('api.githubcopilot.com');
    // The suite-level afterAll guard must not fail on this deliberate attempt.
    attempts.splice(0);
  });

  it('allows loopback fixture traffic', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw Error('no_address');
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/probe`);
      expect(await response.text()).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
