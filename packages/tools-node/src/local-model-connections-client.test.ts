import { expect, it, vi } from 'vitest';
import { localModelConnectionsClient } from './local-model-connections-client.js';
import { LOCAL_MODEL_CONNECTIONS } from '@runnets/contracts';
it('refuses every wrapper locally before wire use without its independent marker', async () => {
  const send = vi.fn();
  const client = localModelConnectionsClient(send, { capabilities: [] });
  for (const name of Object.keys(client) as (keyof typeof client)[])
    await expect((client[name] as (input: unknown) => Promise<unknown>)({})).rejects.toThrow(
      'model_runtime_upgrade_required',
    );
  expect(Object.keys(client)).toHaveLength(11);
  expect(send).not.toHaveBeenCalled();
});
it('validates scope and grants a check the same framing slack as the legacy probe', async () => {
  const send = vi.fn().mockResolvedValue({
    version: 1,
    workspaceId: 'other',
    roomId: 'room',
    policy: { roomId: 'room', revision: 1, cloudTransfer: 'allow' },
  });
  const client = localModelConnectionsClient(send, { capabilities: [LOCAL_MODEL_CONNECTIONS] });
  await expect(client.getRoomModelPolicy({ workspaceId: 'ws', roomId: 'room' })).rejects.toThrow(
    'invalid_frame',
  );
  send.mockResolvedValue({});
  await expect(client.checkModelConnection({ connectionId: 'c'.repeat(256) })).rejects.toThrow(
    'invalid_frame',
  );
  expect(send).toHaveBeenLastCalledWith(
    'modelConnections.check',
    { connectionId: 'c'.repeat(256) },
    12000,
  );
});
it('rejects mismatched page scope, ordering, pagination and oversized replies', async () => {
  const { metadata } = await import('../../contracts/test-fixtures/local-model.js');
  const page = { version: 1, workspaceId: 'ws', items: [metadata()], nextAfter: null };
  const send = vi.fn().mockResolvedValue(page);
  const client = localModelConnectionsClient(send, { capabilities: [LOCAL_MODEL_CONNECTIONS] });
  expect(await client.listModelConnections({ workspaceId: 'ws', after: 'a', limit: 1 })).toEqual(
    page,
  );
  for (const bad of [
    { ...page, workspaceId: 'foreign' },
    { ...page, nextAfter: 'omitted' },
    { ...page, items: [metadata(), metadata()] },
    { ...page, items: [{ ...metadata(), key: 'private' }] },
  ]) {
    send.mockResolvedValue(bad);
    await expect(client.listModelConnections({ workspaceId: 'ws', limit: 1 })).rejects.toThrow(
      'invalid_frame',
    );
  }
});
it('copies nested request identity before awaiting an untrusted reply', async () => {
  let resolve!: (v: unknown) => void;
  const send = vi.fn(
    (_method: string, _params: unknown) =>
      new Promise<unknown>((r) => {
        resolve = r;
      }),
  );
  const client = localModelConnectionsClient(send, { capabilities: [LOCAL_MODEL_CONNECTIONS] });
  const input = {
    workspaceId: 'ws',
    requestId: 'r',
    botId: 'bot',
    expectedProfileVersion: 1,
    binding: { connectionId: 'first', modelId: 'model' },
  };
  const result = client.setBotModelBinding(input);
  input.binding.connectionId = 'second';
  expect(send.mock.calls[0]?.[1]).toMatchObject({ binding: { connectionId: 'first' } });
  resolve({
    bot: {
      id: 'bot',
      workspaceId: 'ws',
      handle: 'bot',
      name: 'Bot',
      role: 'Fixture',
      provider: 'provider',
      model: 'model',
      profileVersion: 2,
    },
    binding: { connectionId: 'second', modelId: 'model' },
  });
  await expect(result).rejects.toThrow('invalid_frame');
});
