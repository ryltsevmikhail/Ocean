// One targeted real credential flow; no model/business/metadata request is needed.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProviderSecretStore } from '@runnets/tools-node';
import { wait } from './current-window.mjs';
export async function serviceSettingsCredentials({ root, ready, peer, first }) {
  const page = first.page,
    secrets = createProviderSecretStore(join(root, 'profile.credentials'));
  await page.getByRole('button', { name: 'Service QA', exact: true }).click();
  await page.getByRole('button', { name: 'Плагины', exact: true }).click();
  const find = async (id) => (await peer.serviceConnections()).find((c) => c.id === id);
  await page.getByTestId('service-id').fill('B');
  await page.getByTestId('service-name').fill('Persisted B');
  await page.getByTestId('service-url').fill(ready.endpoint);
  await page.getByTestId('service-key').fill('synthetic-B-real-saved');
  await page.getByTestId('service-save').click();
  await wait(async () => !!(await find('B')));
  await page.getByTestId('service-select').selectOption('B');
  const before = await find('B'),
    privateRef = before.credentialReference.slice(6);
  assert.equal(secrets.read(privateRef).status, 'ok');
  await page.getByTestId('service-disconnect').click();
  await wait(async () => (await find('B'))?.state === 'disconnected');
  await page.getByTestId('service-name').fill('UNSAVED');
  await page.getByTestId('service-url').fill('http://127.0.0.1:9/dirty');
  await page.getByTestId('service-permission').selectOption('allow');
  await page.getByTestId('service-transport').selectOption('stdio');
  await page.getByTestId('service-executable').fill('/dirty.js');
  await page.getByTestId('service-remove-key').click();
  await wait(async () => (await find('B'))?.credentialReference === null);
  const removed = await find('B');
  assert.equal(removed.state, 'disconnected');
  assert.equal(removed.readiness, 'disconnected');
  assert.equal(removed.name, before.name);
  assert.deepEqual(removed.configuration, before.configuration);
  assert.equal(removed.trust.metadataPermission, before.trust.metadataPermission);
  assert.deepEqual(secrets.read(privateRef), { status: 'absent' });
  await page.screenshot({ path: join(root, 'credentials-isolated-removal.png') });
  // Existing valid private store, intentionally insecure fixture directory: A cannot publish.
  chmodSync(join(root, 'profile.credentials'), 0o755);
  await page.getByTestId('service-select').selectOption('');
  await page.getByTestId('service-id').fill('A');
  await page.getByTestId('service-name').fill('Prepared A');
  await page.getByTestId('service-url').fill(ready.endpoint);
  await page.getByTestId('service-key').fill('synthetic-A-original');
  await page.getByTestId('service-save').click();
  let prepared;
  await wait(async () => {
    prepared = (await peer.listServiceOwnerOperations({ state: 'prepared' })).items[0];
    return !!prepared;
  });
  assert.equal(await find('A'), undefined);
  assert.equal(prepared.targetId, 'A');
  chmodSync(join(root, 'profile.credentials'), 0o700);
  await page.getByTestId('service-select').selectOption('B');
  await page.getByTestId('service-key').fill('synthetic-B-wrong-destination');
  const settingsCalls = () =>
    readFileSync(join(root, 'peer-facts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((r) => r.kind === 'settings-set-input');
  const callsBefore = settingsCalls().length;
  const countBefore = (await peer.listServiceOwnerOperations({ limit: 100 })).items.length;
  await page.getByTestId('service-recovery-select').click();
  assert.equal(await page.getByTestId('service-key').inputValue(), '');
  assert.equal(await page.getByTestId('service-recovery-key').inputValue(), '');
  const destination = await page.getByTestId('service-recovery-destination').innerText();
  assert.ok(destination.includes(prepared.requestId));
  assert.ok(destination.includes(ready.endpoint));
  assert.match(destination, /Подключение A/);
  await page.getByTestId('service-recover').click();
  await page.getByTestId('service-message').filter({ hasText: 'свежий ключ' }).waitFor();
  assert.equal(settingsCalls().length, callsBefore);
  assert.equal((await peer.listServiceOwnerOperations({ limit: 100 })).items.length, countBefore);
  assert.equal(await find('A'), undefined);
  await page.screenshot({ path: join(root, 'credentials-wrong-destination-refused.png') });
  await page.getByTestId('service-recovery-key').fill('synthetic-A-fresh-exact');
  await page.getByTestId('service-recover').click();
  await wait(async () => !!(await find('A')));
  const recovered = await find('A'),
    aRef = recovered.credentialReference.slice(6);
  assert.equal(secrets.read(aRef).key, 'synthetic-A-fresh-exact');
  assert.equal((await find('B')).credentialReference, null);
  assert.equal((await find('B')).state, 'disconnected');
  assert.equal((await peer.serviceReceipt({ requestId: prepared.requestId })).state, 'prepared');
  const operations = (await peer.listServiceOwnerOperations({ limit: 100 })).items,
    recovery = operations.find((x) => x.targetId === 'A' && x.state === 'completed');
  assert.ok(recovery);
  assert.notEqual(recovery.requestId, prepared.requestId);
  assert.equal(await page.getByTestId('service-recovery-key').count(), 0);
  await page.screenshot({ path: join(root, 'credentials-fresh-exact-recovery.png') });
  const stored = readFileSync(join(root, 'profile.credentials/providers.json'), 'utf8');
  assert.ok(!stored.includes('synthetic-B-wrong-destination'));
  return {
    removed,
    before,
    destination,
    wrongDestinationSent: false,
    settingsCalls: settingsCalls(),
    unchangedOperationCountOnRefusal: countBefore,
    prepared,
    recovery,
    recovered,
    realSavedKeyRemoved: secrets.read(privateRef).status === 'absent',
    exactFreshKeyPresent: secrets.read(aRef).key === 'synthetic-A-fresh-exact',
  };
}
