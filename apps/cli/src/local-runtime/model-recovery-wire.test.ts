import { afterEach, expect, it, vi } from 'vitest';
import { connectLocalRuntime, createProviderSecretStore } from '@runnets/tools-node';
import { privateRoot, startProviderHost } from '../../test-fixtures/local-provider-host.test.js';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});
it.each(['model', 'provider'] as const)(
  'exposes the exact keyless %s recovery family and requires explicit same-key replay',
  async (family) => {
    const profile = await privateRoot();
    cleanups.push(() => profile.dispose());
    const actual = createProviderSecretStore(profile.credentialDir);
    const secrets = {
      read: vi.fn(actual.read),
      write: vi.fn(actual.write),
      replace: vi.fn(actual.replace),
      remove: vi.fn(actual.remove),
    };
    secrets.write.mockImplementationOnce(() => {
      throw Error('provider_write_failed');
    });
    const started = await startProviderHost(profile, { baseUrl: '', secretStore: secrets });
    cleanups.push(() => started.stop());
    const other = await connectLocalRuntime({ profile: profile.profile });
    cleanups.push(() => other.close());
    const input = {
      connectionId: 'named',
      requestId: 'pending',
      expectedRevision: null,
      providerId: 'deepseek',
      kind: 'cloud' as const,
      endpoint: 'https://api.deepseek.com',
      auth: 'api_key' as const,
      defaultModelId: 'deepseek-flash',
      key: 'fixture-original-key',
    };
    const legacy = { requestId: 'pending', model: 'deepseek-flash', key: input.key };
    const replay = (key: string) =>
      family === 'model'
        ? other.setModelConnection({ ...input, key })
        : other.providerSet({ ...legacy, key });
    await expect(
      family === 'model'
        ? started.client.setModelConnection(input)
        : started.client.providerSet(legacy),
    ).rejects.toThrow('provider_write_failed');
    secrets.read.mockClear();
    secrets.write.mockClear();
    const page = await other.listModelConnections();
    const pending = page.items.find(
      (item) => item.connectionId === (family === 'model' ? 'named' : 'legacy:deepseek'),
    )!;
    expect(secrets.read).not.toHaveBeenCalled();
    expect(secrets.write).not.toHaveBeenCalled();
    expect(pending.recovery).toMatchObject({
      kind: 'retry_available',
      pendingRevision: 1,
      requiresKeyResupply: true,
      request: {
        version: 1,
        operation: {
          method: family === 'model' ? 'modelConnections.set' : 'provider.set',
          keyWasSupplied: true,
        },
      },
    });
    if (pending.recovery?.kind !== 'retry_available') throw Error('fixture recovery');
    const operation = pending.recovery.request.operation;
    expect(operation.input).toEqual(
      family === 'model'
        ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'key'))
        : { requestId: 'pending', model: 'deepseek-flash' },
    );
    expect(JSON.stringify(page)).not.toMatch(
      /fixture-original-key|secretRef|previousRef|nextRef|binding/,
    );
    await expect(replay('fixture-wrong-key')).rejects.toThrow('request_conflict');
    expect(secrets.write).not.toHaveBeenCalled();
    expect(await replay(input.key)).toMatchObject({ revision: 1, state: 'connected' });
    expect(secrets.write).toHaveBeenCalledTimes(1);
    expect(
      (await other.listModelConnections()).items.find(
        (item) => item.connectionId === pending.connectionId,
      )?.recovery,
    ).toBeNull();
  },
);
