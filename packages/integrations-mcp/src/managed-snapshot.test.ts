import { expect, it, vi } from 'vitest';
import type { SessionWriter } from './session-writer.js';
import { createMcpServiceTransport } from './index.js';
import { connection } from '../test-fixtures/admission.js';
import { httpFixture } from './prototype-http-fixture.js';
const state = vi.hoisted(() => ({
  url: '',
  inspect: vi.fn(() => {
    throw Error('physical I/O in semantic lookup');
  }),
}));
vi.mock('./stdio.js', async () => {
  const { serviceHttp } = await import('./http.js');
  return {
    serviceStdio: async (_c: unknown, _o: unknown, writer: SessionWriter) => ({
      // Source-only managed-session double. The SDK metadata exchange is real loopback HTTP.
      transport: serviceHttp(state.url, null, false, writer),
      managed: { handle: { inspect: state.inspect }, lifetime: { record: {} } },
      lost() {},
      prepareRetirement: async () => {},
      cleanup: async () => ({ status: 'confirmed' }),
    }),
  };
});
it('reads exact active managed generation facts without platform I/O inside authority classification', async () => {
  const fixture = await httpFixture('normal');
  state.url = fixture.url.href;
  const c = connection({
    kind: 'stdio',
    executable: '/owned/server.mjs',
    workspaceRoot: '/owned/workspace',
    sha256: 'a'.repeat(64),
    args: [],
  });
  const transport = createMcpServiceTransport({});
  try {
    const candidate = await transport.discover(c, {
      signal: new AbortController().signal,
      deadlineMs: 2000,
      authorizeMetadata: () => true,
    });
    expect(transport.activate(candidate, { ...candidate, id: 'catalog' }, () => true)).toBe(true);
    expect(transport.managed({ ...c, currentCatalogId: 'catalog' })).toBeTruthy();
    expect(state.inspect).not.toHaveBeenCalled();
  } finally {
    await transport.close();
    await fixture.close();
  }
});
