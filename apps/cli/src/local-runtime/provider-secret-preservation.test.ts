import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProviderSecretStore } from '@runnets/tools-node';
import { privateRoot, startProviderHost } from '../../test-fixtures/local-provider-host.test.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('provider and model owner writes refuse a corrupt shared private file without silently resetting it', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const secrets = createProviderSecretStore(f.credentialDir);
  secrets.write('psec_unrelatedprovider', 'synthetic-unrelated');
  const started = await startProviderHost(f, { baseUrl: '', secretStore: secrets });
  cleanup.push(() => started.stop());
  await started.client.providerSet({
    requestId: 'initial',
    model: 'deepseek-flash',
    key: 'synthetic-first',
  });
  const file = join(f.credentialDir, 'providers.json');
  writeFileSync(file, '{corrupt shared synthetic state');
  const before = readFileSync(file);
  await expect(
    started.client.providerSet({
      requestId: 'provider-resupply',
      model: 'deepseek-flash',
      key: 'synthetic-second',
    }),
  ).rejects.toThrow('provider_write_failed');
  expect(readFileSync(file)).toEqual(before);
  await expect(
    started.client.setModelConnection({
      connectionId: 'owned-model',
      requestId: 'model-resupply',
      expectedRevision: null,
      providerId: 'deepseek',
      kind: 'cloud',
      endpoint: 'https://api.deepseek.com',
      auth: 'api_key',
      defaultModelId: 'deepseek-flash',
      key: 'synthetic-third',
    }),
  ).rejects.toThrow('provider_write_failed');
  expect(readFileSync(file)).toEqual(before);
  expect(await started.client.providerStatus()).toMatchObject({
    state: 'unverified',
    source: 'none',
  });
});
