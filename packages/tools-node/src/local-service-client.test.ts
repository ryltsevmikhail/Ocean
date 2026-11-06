import { expect, it, vi } from 'vitest';
import { LOCAL_SERVICE_AUTHORITY, LOCAL_SERVICE_METHODS } from '@runnets/contracts';
import { serviceConnection, ownerGrant } from '../../../test-fixtures/service-authority.js';
import { localServiceClient } from './local-service-client.js';
const identity = { capabilities: [LOCAL_SERVICE_AUTHORITY, ...LOCAL_SERVICE_METHODS] };
const request = {
  requestId: 'request',
  connectionId: serviceConnection.id,
  expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
};
const done = {
  requestId: request.requestId,
  method: 'service.connection-disconnect',
  state: 'completed',
  recovery: null,
  result: serviceConnection,
};
it('requires independent support before any input or wire use, with an explicit operations upgrade', async () => {
  const send = vi.fn();
  const client = localServiceClient(send, { capabilities: [] });
  for (const [name, method] of Object.entries(client)) {
    await expect((method as (q: unknown) => Promise<unknown>)({})).rejects.toThrow(
      name === 'listServiceOwnerOperations'
        ? 'service_operations_upgrade_required'
        : 'service_runtime_upgrade_required',
    );
  }
  const older = localServiceClient(send, {
    capabilities: [
      LOCAL_SERVICE_AUTHORITY,
      ...LOCAL_SERVICE_METHODS.filter((m) => m !== 'service.owner-operations'),
    ],
  });
  await expect(older.listServiceOwnerOperations({})).rejects.toThrow(
    'service_operations_upgrade_required',
  );
  expect(send).not.toHaveBeenCalled();
});
it('validates strict requests, request/method/target correlation and prepared/null facts', async () => {
  const send = vi.fn().mockResolvedValue(done),
    client = localServiceClient(send, identity);
  expect(await client.disconnectServiceConnection(request)).toEqual(done);
  for (const bad of [
    { ...done, requestId: 'foreign' },
    { ...done, method: 'service.connection-set' },
    { ...done, result: { ...serviceConnection, id: 'foreign' } },
    { ...done, result: { ...serviceConnection, key: 'secret' } },
    { ...done, state: 'prepared' },
    { ...done, result: null },
    { ...done, extra: 'private' },
  ]) {
    send.mockResolvedValue(bad);
    await expect(client.disconnectServiceConnection(request)).rejects.toThrow('invalid_frame');
  }
  send.mockResolvedValue(null);
  expect(await client.serviceReceipt({ requestId: 'absent' })).toBeNull();
  const prepared = {
    ...done,
    state: 'prepared',
    result: null,
    recovery: 'explicit_recovery_required',
  };
  send.mockResolvedValue(prepared);
  expect(await client.disconnectServiceConnection(request)).toEqual(prepared);
  send.mockClear();
  await expect(client.serviceReceipt({ requestId: 'x', key: 'private' } as never)).rejects.toThrow(
    'invalid_params',
  );
  await expect(client.listServiceOwnerOperations({ limit: 101 })).rejects.toThrow('invalid_params');
  expect(send).not.toHaveBeenCalled();
});
it('normalizes older authority-v2 readiness to unknown and rejects unsolicited fields', async () => {
  const send = vi.fn().mockResolvedValue([{ ...serviceConnection, tools: ['tool'] }]);
  const client = localServiceClient(send, identity);
  expect(await client.serviceConnections()).toEqual([
    { ...serviceConnection, tools: ['tool'], readiness: 'unknown' },
  ]);
  for (const extra of [
    { key: 'private' },
    { secretReference: 'private' },
    { readiness: 'maybe' },
  ]) {
    send.mockResolvedValue([{ ...serviceConnection, tools: [], ...extra }]);
    await expect(client.serviceConnections()).rejects.toThrow('invalid_frame');
  }
  send.mockResolvedValue([ownerGrant]);
  expect(await client.serviceGrants()).toEqual([ownerGrant]);
});
it('checks state, ordering, cursor, intent secrecy and original intent correlation', async () => {
  const item = {
    requestId: 'b',
    method: 'service.connection-refresh',
    state: 'prepared',
    recovery: 'explicit_recovery_required',
    targetId: request.connectionId,
    operation: {
      method: 'service.connection-refresh',
      input: { ...request, requestId: 'b' },
      requiresKey: false,
    },
  };
  const page = { items: [item], next: 'b' },
    send = vi.fn().mockResolvedValue(page),
    client = localServiceClient(send, identity);
  const query = { after: 'a', limit: 1, state: 'prepared' as const };
  expect(await client.listServiceOwnerOperations(query)).toEqual(page);
  for (const bad of [
    { ...page, next: 'skip' },
    { ...page, items: [item, item] },
    { ...page, items: [{ ...item, requestId: 'a' }] },
    { ...page, items: [{ ...item, state: 'completed', recovery: null }] },
    {
      ...page,
      items: [
        {
          ...item,
          operation: { ...item.operation, input: { ...item.operation.input, key: 'private' } },
        },
      ],
    },
    { ...page, items: [{ ...item, targetId: 'foreign' }] },
  ]) {
    send.mockResolvedValue(bad);
    await expect(client.listServiceOwnerOperations(query)).rejects.toThrow('invalid_frame');
  }
});
it('copies mutable inputs before awaiting and uses metadata framing slack', async () => {
  let resolve!: (v: unknown) => void;
  const send = vi.fn(
    (_m: string, _p: unknown, _t?: number) =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const client = localServiceClient(send, identity),
    input = structuredClone(request);
  const result = client.refreshServiceConnection(input);
  input.expectedVersions.configRevision = 9;
  expect(send).toHaveBeenCalledWith('service.connection-refresh', request, 20000);
  resolve({ ...done, method: 'service.connection-refresh' });
  expect(await result).toMatchObject({ state: 'completed' });
});
it('compares opaque request IDs in SQLite binary order, including supplementary Unicode', async () => {
  const item = {
    method: 'service.connection-set',
    state: 'prepared',
    recovery: 'explicit_recovery_required',
    targetId: null,
    operation: null,
  };
  const send = vi.fn().mockResolvedValue({
    items: [
      { ...item, requestId: '\ue000' },
      { ...item, requestId: '\u{10000}' },
    ],
    next: null,
  });
  expect(
    (await localServiceClient(send, identity).listServiceOwnerOperations({})).items,
  ).toHaveLength(2);
});
