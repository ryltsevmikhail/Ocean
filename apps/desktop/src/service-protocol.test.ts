import { expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { commands, outputs } from './protocol.js';
import { dispatch } from './host/runtime-client.js';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
const input = {
  requestId: 'original',
  connectionId: 'c',
  expectedVersions: null,
  name: 'Service',
  configuration: { kind: 'http' as const, url: 'http://127.0.0.1:8080/mcp' },
  metadataPermission: 'none' as const,
};
it('detaches public service DTOs and refuses renderer authority or stdio secrets', () => {
  const parsed = commands.parse({ op: 'service-set', input: reactive(input) });
  expect(parsed).toEqual({ op: 'service-set', input });
  expect('input' in parsed && parsed.input).not.toBe(input);
  expect(
    commands.safeParse({ op: 'service-set', input: { ...input, ownerId: 'other' } }).success,
  ).toBe(false);
  expect(
    commands.safeParse({
      op: 'service-set',
      input: {
        ...input,
        key: 'secret',
        configuration: {
          kind: 'stdio',
          executable: '/server.js',
          sha256: 'a'.repeat(64),
          args: [],
        },
      },
    }).success,
  ).toBe(false);
  expect(
    commands.safeParse({ op: 'service-decisions', input: { workspaceId: 'other', roomId: 'r' } })
      .success,
  ).toBe(false);
  expect(
    outputs['service-receipt'].safeParse({
      requestId: 'x',
      method: 'service.connection-set',
      state: 'completed',
      recovery: null,
      result: null,
    }).success,
  ).toBe(false);
});
it('negotiates current, historical and refused support explicitly', async () => {
  const client = (capabilities: string[]) =>
    ({ identity: { capabilities } }) as unknown as LocalRuntimeClient;
  expect(await dispatch(client([]), { op: 'service-support' } as never)).toEqual({
    current: false,
    historical: false,
    historicalOnly: false,
    decisions: false,
  });
  expect(
    await dispatch(
      client([
        'plugin.connections',
        'plugin.access-list',
        'plugin.operations-list',
        'plugin.catalog',
      ]),
      { op: 'service-support' } as never,
    ),
  ).toEqual({ current: false, historical: true, historicalOnly: false, decisions: false });
  await expect(dispatch(client([]), { op: 'service-connections' } as never)).rejects.toThrow(
    'service_runtime_upgrade_required',
  );
});
it('delegates the original receipt and mutations to the accepted shared client', async () => {
  const setServiceConnection = vi.fn().mockResolvedValue('saved'),
    serviceReceipt = vi.fn().mockResolvedValue(null);
  const client = {
    identity: {
      capabilities: ['service.authority-v2', 'service.connection-set', 'service.receipt'],
    },
    setServiceConnection,
    serviceReceipt,
  } as unknown as LocalRuntimeClient;
  expect(await dispatch(client, { op: 'service-set', input } as never)).toBe('saved');
  await dispatch(client, { op: 'service-receipt', input: { requestId: 'original' } } as never);
  expect(setServiceConnection).toHaveBeenCalledExactlyOnceWith(input);
  expect(serviceReceipt).toHaveBeenCalledExactlyOnceWith({ requestId: 'original' });
});

it('normalizes missing historical readiness to unknown and rejects malformed detached output', async () => {
  const { serviceConnection } = await import('../../../test-fixtures/service-authority.js');
  const view = { ...serviceConnection, tools: ['a,b', 'x y'] };
  expect(outputs['service-connections'].parse([view])[0]?.readiness).toBe('unknown');
  expect(outputs['service-connections'].parse([view])[0]?.tools).toEqual(['a,b', 'x y']);
  expect(outputs['service-connections'].safeParse([{ ...view, key: 'leak' }]).success).toBe(false);
  const malicious = { ...view, toJSON: () => ({ ...view, key: 'leak' }) };
  expect(outputs['service-connections'].safeParse([malicious]).success).toBe(false);
});
it('never exposes writable historical fallback for a partially capable current runtime', async () => {
  const { LOCAL_PLUGIN_METHODS } = await import('@runnets/contracts');
  const c = (caps: readonly string[]) =>
    ({ identity: { capabilities: caps } }) as unknown as LocalRuntimeClient;
  expect(await dispatch(c(LOCAL_PLUGIN_METHODS), { op: 'service-support' } as never)).toMatchObject(
    { historical: true, historicalOnly: true, current: false },
  );
  expect(
    await dispatch(c(['service.authority-v2', ...LOCAL_PLUGIN_METHODS]), {
      op: 'service-support',
    } as never),
  ).toMatchObject({ historical: true, historicalOnly: false, current: false });
});
it('routes all nine accepted settings methods and four exact decision methods', async () => {
  const { LOCAL_SERVICE_AUTHORITY, LOCAL_SERVICE_METHODS, LOCAL_SERVICE_CONFIRMATIONS } =
    await import('@runnets/contracts');
  const methods = [
    ['service-connections', 'serviceConnections'],
    ['service-grants', 'serviceGrants'],
    ['service-receipt', 'serviceReceipt'],
    ['service-set', 'setServiceConnection'],
    ['service-disconnect', 'disconnectServiceConnection'],
    ['service-refresh', 'refreshServiceConnection'],
    ['service-grant', 'setOwnerScopeGrant'],
    ['service-revoke', 'revokeOwnerScopeGrant'],
    ['service-operations', 'listServiceOwnerOperations'],
    ['service-decisions', 'listDecisions'],
    ['service-decision', 'getDecision'],
    ['service-preview', 'decisionPreview'],
    ['service-resolve', 'resolveDecision'],
  ] as const;
  for (const [op, method] of methods) {
    const delegated = vi.fn().mockResolvedValue('exact result');
    const client = {
      identity: {
        capabilities: [
          LOCAL_SERVICE_AUTHORITY,
          ...LOCAL_SERVICE_METHODS,
          LOCAL_SERVICE_CONFIRMATIONS,
        ],
      },
      [method]: delegated,
    } as unknown as LocalRuntimeClient;
    const input = { requestId: 'original', bindingDigest: 'a'.repeat(64) };
    expect(await dispatch(client, { op, input } as never)).toBe('exact result');
    if (op === 'service-connections' || op === 'service-grants')
      expect(delegated).toHaveBeenCalledExactlyOnceWith();
    else expect(delegated).toHaveBeenCalledExactlyOnceWith(input);
  }
});
