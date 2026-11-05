import { afterEach, expect, it, vi } from 'vitest';
import { ModelConnectionService } from '@runnets/application';
import { createProviderSecretStore } from '@runnets/tools-node';
import { privateRoot, startProviderHost } from '../../test-fixtures/local-provider-host.test.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const profile = await privateRoot();
  cleanup.push(() => profile.dispose());
  const secrets = createProviderSecretStore(profile.credentialDir);
  const host = await startProviderHost(profile, { baseUrl: '', secretStore: secrets });
  cleanup.push(() => host.stop());
  return { ...host, secrets };
}
const desired = {
  connectionId: 'legacy:deepseek',
  providerId: 'deepseek',
  kind: 'cloud' as const,
  endpoint: 'https://api.deepseek.com',
  auth: 'api_key' as const,
  defaultModelId: 'deepseek-flash',
};
it('canonical CAS repairs exactly the legacy null-intent row and refuses pending-envelope supersession', async () => {
  const f = await fixture();
  const calls = vi.spyOn(ModelConnectionService.prototype, 'set');
  await f.client.setModelConnection({
    ...desired,
    requestId: 'initial',
    expectedRevision: 0,
    key: 'synthetic-initial',
  });
  const service = calls.mock.contexts[0] as ModelConnectionService;
  const saved = service.options.store.read(desired.connectionId)!;
  service.options.store.put(
    { ...saved, intent: 'pending', pendingRequest: null, pendingSecretChange: null },
    saved.revision,
  );
  expect(
    (await f.client.listModelConnections()).items.find(
      (x) => x.connectionId === desired.connectionId,
    )?.recovery?.kind,
  ).toBe('explicit_key_repair_required');
  const repair = {
    ...desired,
    requestId: 'explicit-repair',
    expectedRevision: 1,
    key: 'synthetic-repair',
  };
  const fail = vi.spyOn(f.secrets, 'replace').mockImplementationOnce(() => {
    throw Error('fixture publication');
  });
  await expect(f.client.setModelConnection(repair)).rejects.toThrow('provider_write_failed');
  const pending = service.options.store.read(desired.connectionId)!;
  expect(pending.pendingSecretChange).not.toBeNull();
  for (const attempt of [
    () => f.client.setModelConnection({ ...repair, requestId: 'supersede', expectedRevision: 2 }),
    () =>
      f.client.disconnectModelConnection({
        connectionId: desired.connectionId,
        requestId: 'off',
        expectedRevision: 2,
      }),
    () =>
      f.client.removeModelConnectionKey({
        connectionId: desired.connectionId,
        requestId: 'remove',
        expectedRevision: 2,
      }),
  ])
    await expect(attempt()).rejects.toThrow('provider_unverified');
  expect(service.options.store.read(desired.connectionId)).toEqual(pending);
  fail.mockRestore();
  expect(await f.client.setModelConnection(repair)).toMatchObject({
    connectionId: desired.connectionId,
    revision: 2,
    source: 'saved',
  });
  expect(service.options.store.read(desired.connectionId)?.legacyEnvironment).toBe(
    saved.legacyEnvironment,
  );
  await expect(
    f.client.setModelConnection({
      ...desired,
      connectionId: 'legacy:other',
      requestId: 'wrong-scope',
      expectedRevision: null,
      key: 'synthetic',
    }),
  ).rejects.toThrow('connection_unverified');
  expect(service.options.store.read('legacy:other')).toBeNull();
});
it('actual legacy replay preserves provider.set and original revision omission', async () => {
  const f = await fixture();
  await f.client.providerSet({
    requestId: 'first',
    model: 'deepseek-flash',
    key: 'synthetic-first',
  });
  const fail = vi.spyOn(f.secrets, 'replace').mockImplementationOnce(() => {
    throw Error('fixture publication');
  });
  const original = {
    requestId: 'legacy-original',
    model: 'deepseek-flash',
    key: 'synthetic-second',
  };
  await expect(f.client.providerSet(original)).rejects.toThrow('provider_write_failed');
  const recovery = (await f.client.listModelConnections()).items.find(
    (x) => x.connectionId === 'legacy:deepseek',
  )?.recovery;
  expect(recovery?.kind).toBe('retry_available');
  if (recovery?.kind !== 'retry_available' || recovery.request.operation.method !== 'provider.set')
    throw Error('fixture recovery');
  expect(recovery.request.operation.input).toEqual({
    requestId: original.requestId,
    model: original.model,
  });
  expect(recovery.request.operation.input).not.toHaveProperty('expectedRevision');
  fail.mockRestore();
  const result = await f.client.providerSet({
    ...recovery.request.operation.input,
    key: original.key,
  });
  expect(result).toMatchObject({ revision: 2, source: 'saved' });
  expect(await f.client.providerSet(original)).toEqual(result);
});
