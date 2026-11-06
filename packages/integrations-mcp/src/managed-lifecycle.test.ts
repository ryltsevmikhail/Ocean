import { expect, it, vi } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connection } from '../test-fixtures/admission.js';
import { SessionWriter } from './session-writer.js';
import { serviceStdio } from './stdio.js';
const state = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('@runnets/tools-node', () => ({
  prepareManagedStdio: async () => ({
    parameters: { command: '/never-spawned' },
    footprint: {},
    nonce: 'nonce',
    unit: 'unit',
    cgroup: 'cgroup',
    inspect: () => true,
    start: () => state.events.push('attempt'),
    observe: async () => {},
    cleanup: async () => 'confirmed',
  }),
}));
it('refuses executable start without the private runtime lifetime authority', async () => {
  const starts = vi.spyOn(StdioClientTransport.prototype, 'start').mockResolvedValue();
  const options = { stdio: { profileRoot: '/profile' } };
  const writer = new SessionWriter(
    new AbortController().signal,
    { signal: new AbortController().signal, deadlineMs: 1000, authorizeMetadata: () => true },
    options,
  );
  const c = connection({
    kind: 'stdio',
    executable: '/server.mjs',
    sha256: 'a'.repeat(64),
    args: [],
    workspaceRoot: '/workspace',
  });
  try {
    const stdio = await serviceStdio(c, options, writer, null);
    await expect(stdio.transport.start()).rejects.toThrow();
    expect(starts).not.toHaveBeenCalled();
  } finally {
    starts.mockRestore();
  }
});
it('denies direct business SDK writes without the exact runtime lifetime generation', async () => {
  const { InvocationSend } = await import('./send.js');
  const { managedLifetimeFixture } =
    await import('../../store-sqlite/test-fixtures/managed-lifetime.js');
  const record = managedLifetimeFixture().record;
  const starts = vi.spyOn(StdioClientTransport.prototype, 'start').mockResolvedValue();
  const sends = vi.spyOn(StdioClientTransport.prototype, 'send').mockResolvedValue();
  const options = {
    stdio: { profileRoot: '/profile' },
    prepareManagedLifetime: () => Promise.resolve({ record, begin: () => true, finish: () => {} }),
  };
  const writer = new SessionWriter(
    new AbortController().signal,
    { signal: new AbortController().signal, deadlineMs: 1000, authorizeMetadata: () => true },
    options,
  );
  const c = connection({
    kind: 'stdio',
    executable: '/server.mjs',
    sha256: 'a'.repeat(64),
    args: [],
    workspaceRoot: '/workspace',
  });
  try {
    const stdio = await serviceStdio(c, options, writer, null);
    await stdio.transport.start();
    writer.discovering = false;
    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'write', arguments: {} },
    };
    const direct = new InvocationSend(1000, undefined, 'direct', () => true);
    await expect(direct.run(() => stdio.transport.send(message))).rejects.toThrow();
    expect(sends).not.toHaveBeenCalled();
    const stale = new InvocationSend(
      1000,
      undefined,
      'stale',
      () => true,
      undefined,
      '0'.repeat(64),
    );
    await expect(stale.run(() => stdio.transport.send(message))).rejects.toThrow();
    const current = new InvocationSend(
      1000,
      undefined,
      'current',
      () => true,
      undefined,
      record.fingerprint,
    );
    await current.run(() => stdio.transport.send(message));
    expect(sends).toHaveBeenCalledTimes(1);
  } finally {
    starts.mockRestore();
    sends.mockRestore();
  }
});
