import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { wait } from './current-window.mjs';
const versions = (c) => ({
  configRevision: c.configRevision,
  trustRevision: c.trustRevision,
  credentialRevision: c.credentialRevision,
});
export async function serviceSettingsFlow({ root, ready, peer, first, independent, reopenFirst }) {
  let page = first.page;
  const open = async (p = page) => {
    await p.getByRole('button', { name: 'Плагины', exact: true }).click();
    await p.getByTestId('service-save').waitFor();
  };
  const close = async (p = page) =>
    p.getByRole('button', { name: 'Закрыть сервисы', exact: true }).click();
  const fill = async (id, name = id) => {
    await page.getByTestId('service-select').selectOption('');
    await page.getByTestId('service-id').fill(id);
    await page.getByTestId('service-name').fill(name);
    await page.getByTestId('service-url').fill(ready.endpoint);
  };
  const connection = async (id) => (await peer.serviceConnections()).find((c) => c.id === id);
  await page.getByRole('button', { name: 'Service QA', exact: true }).click();
  await page.getByRole('heading', { name: 'Service QA', exact: true }).waitFor();
  await first.inspectMain('win.setSize(1024, 768), true');
  await page.getByLabel('Сообщение', { exact: true }).fill('focus reachability');
  await page.getByLabel('Сообщение', { exact: true }).focus();
  assert.equal(
    await page
      .getByLabel('Сообщение', { exact: true })
      .evaluate(
        (el) =>
          el.ownerDocument.activeElement === el &&
          el.getBoundingClientRect().right <= el.ownerDocument.defaultView.innerWidth,
      ),
    true,
  );
  await page.screenshot({ path: join(root, '01-width-1024.png') });
  await open();
  await fill('current', 'Current service');
  await page.getByTestId('service-save').click();
  await wait(async () => !!(await connection('current')));
  await page.getByTestId('service-select').selectOption('current');
  assert.equal(
    await page.getByTestId('service-current').getAttribute('data-readiness'),
    'metadata_required',
  );
  assert.equal(existsSync(join(root, 'dispatches')), false);
  await page.getByTestId('service-permission').selectOption('allow');
  await page.getByTestId('service-save').click();
  await wait(async () => (await connection('current'))?.trust.metadataPermission === 'allow');
  await page.getByTestId('service-refresh').click();
  await wait(async () => (await connection('current'))?.readiness === 'ready');
  await page.getByTestId('service-bot').selectOption(ready.botId);
  await page.getByTestId('service-mode').selectOption('confirm');
  await page.getByTestId('service-tool').check();
  assert.match(await page.getByTestId('service-breadth').innerText(), /ВСЕ ресурсы/);
  await page.getByTestId('service-grant-ack').check();
  await page.getByTestId('service-grant').click();
  await wait(async () => (await peer.serviceGrants()).length === 1);
  const granted = (await peer.serviceGrants())[0];
  assert.equal(granted.mode, 'confirm');
  assert.equal(granted.subject.roomId, ready.roomId);
  await page.screenshot({ path: join(root, '02-current-scope.png') });
  // Actual private-file publication failure after durable prepared receipt.
  mkdirSync(join(root, 'profile.credentials'), { mode: 0o755 });
  chmodSync(join(root, 'profile.credentials'), 0o755);
  await fill('publication');
  await page.getByTestId('service-key').fill('synthetic-publication-key');
  await page.getByTestId('service-save').click();
  await wait(
    async () => (await peer.listServiceOwnerOperations({ state: 'prepared' })).items.length === 1,
  );
  assert.equal(await page.getByTestId('service-key').inputValue(), '');
  const prepared = (await peer.listServiceOwnerOperations({ state: 'prepared' })).items[0];
  assert.equal(prepared.operation.requiresKey, true);
  assert.equal(JSON.stringify(prepared).includes('synthetic-publication-key'), false);
  await close();
  await open();
  await page.getByTestId('service-prepared').waitFor();
  const other = independent('operations');
  assert.equal(other.items[0].requestId, prepared.requestId);
  assert.equal(await connection('publication'), undefined);
  await page.screenshot({ path: join(root, '03-prepared-reopened.png') });
  chmodSync(join(root, 'profile.credentials'), 0o700);
  await page.getByTestId('service-key').fill('synthetic-publication-key');
  await page.getByTestId('service-recover').click();
  await wait(async () => !!(await connection('publication')));
  assert.equal((await peer.serviceReceipt({ requestId: prepared.requestId })).state, 'prepared');
  const all = await peer.listServiceOwnerOperations({ limit: 100 });
  const recovered = all.items.find((x) => x.targetId === 'publication' && x.state === 'completed');
  assert.ok(recovered);
  assert.notEqual(recovered.requestId, prepared.requestId);
  // Lose one already committed reply, then inspect original vs current after a full window reopen.
  await fill('lost', 'Before');
  writeFileSync(join(root, 'drop-reply'), 'drop');
  await page.getByTestId('service-save').click();
  await wait(
    () =>
      existsSync(join(root, 'peer-facts.jsonl')) &&
      readFileSync(join(root, 'peer-facts.jsonl'), 'utf8').includes('dropped-committed-reply'),
  );
  await page.getByTestId('service-message').filter({ hasText: 'completed' }).waitFor();
  const dropped = readFileSync(join(root, 'peer-facts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .find((x) => x.kind === 'dropped-committed-reply');
  assert.equal(independent('receipt', { requestId: dropped.requestId }).result.name, 'Before');
  const lost = await connection('lost');
  await peer.setServiceConnection({
    requestId: 'independent-new-name',
    connectionId: lost.id,
    name: 'After',
    expectedVersions: versions(lost),
    configuration: lost.configuration,
    metadataPermission: 'none',
  });
  await close();
  await first.close();
  await first.dispose();
  first = await reopenFirst();
  page = first.page;
  await page.getByRole('button', { name: 'Service QA', exact: true }).click();
  await open();
  await page.getByTestId('service-select').selectOption('lost');
  await page.getByTestId('service-receipt-id').fill(dropped.requestId);
  await page.getByTestId('service-receipt-lookup').click();
  await page.getByTestId('service-receipt').filter({ hasText: 'Before' }).waitFor();
  assert.equal(await page.getByTestId('service-name').inputValue(), 'After');
  await page.screenshot({ path: join(root, '04-original-vs-current.png') });
  // A held committed response returns after selection/Escape; it must not overwrite feedback.
  await page.getByTestId('service-name').fill('Late');
  writeFileSync(join(root, 'hold-reply'), 'hold');
  await page.getByTestId('service-save').click();
  await wait(
    () =>
      existsSync(join(root, 'peer-facts.jsonl')) &&
      readFileSync(join(root, 'peer-facts.jsonl'), 'utf8').includes('held-committed-reply'),
  );
  await page.getByTestId('service-select').selectOption('current');
  await page.keyboard.press('Escape');
  writeFileSync(join(root, 'release-reply'), 'release');
  await wait(async () => (await connection('lost'))?.name === 'Late');
  await open();
  assert.equal(await page.getByTestId('service-message').count(), 0);
  // Inert archive prefill: declarative config only, actual archived identity retained.
  await page.getByText('Исторический архив — только чтение', { exact: true }).click();
  await page.getByTestId('service-legacy-prefill').click();
  assert.match(await page.getByTestId('service-id').inputValue(), /^legacy-/);
  assert.equal(await page.getByTestId('service-key').inputValue(), '');
  assert.equal(await page.getByTestId('service-permission').inputValue(), 'none');
  assert.match(await page.getByTestId('service-legacy-row').innerText(), /old-account/);
  assert.equal(await page.getByTestId('plugin-operation-acknowledge').count(), 0);
  assert.equal((await peer.serviceGrants()).length, 1);
  await page.screenshot({ path: join(root, '05-inert-legacy.png') });
  // One full current card, observed in two actual processes; exactly one accepted effect.
  await close();
  await page.getByLabel('Кому').selectOption('dev');
  await page.getByLabel('Сообщение', { exact: true }).fill('call synthetic service');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const scope = { workspaceId: 'ws_ocean', roomId: ready.roomId };
  let card;
  await wait(async () => {
    card = (await peer.listDecisions(scope))[0];
    return card?.status === 'pending';
  });
  await open();
  await page.getByTestId('service-decision-card').click();
  await page.getByTestId('service-decision-allow').waitFor({ state: 'visible' });
  const full = await page.getByTestId('service-decision-preview').innerText();
  assert.ok(full.length > 40000);
  assert.ok(full.includes('<script>plain text</script>'));
  assert.equal(await page.getByTestId('service-decision-preview').locator('script').count(), 0);
  const ref = { ...scope, runId: card.runId, decisionId: card.decisionId };
  const observed = independent('decision', ref);
  assert.equal(observed.preview, full);
  assert.equal(observed.card.decisionId, card.decisionId);
  assert.equal(observed.card.bindingDigest, card.bindingDigest);
  assert.equal(observed.card.version, card.version);
  writeFileSync(join(root, 'independent-full-decision.json'), JSON.stringify(observed));
  await page.screenshot({ path: join(root, '06-full-decision.png'), fullPage: true });
  // Closing/reconnecting one GUI while held never resolves or cancels the card.
  await close();
  assert.equal((await peer.getDecision(ref)).status, 'pending');
  await open();
  await page.getByTestId('service-decision-card').click();
  await page.getByTestId('service-decision-allow').click();
  await wait(() => existsSync(join(root, 'dispatches')));
  const stale = independent('resolve', {
    ...ref,
    expectedVersion: 1,
    bindingDigest: card.bindingDigest,
    choice: 'allow-once',
  });
  assert.equal(stale.status, 'allowed');
  assert.equal(independent('decision', ref).card.status, 'allowed');
  writeFileSync(join(root, 'independent-terminal-decision.json'), JSON.stringify(stale));
  assert.equal((await peer.getDecision(ref)).status, 'allowed');
  assert.equal(readFileSync(join(root, 'dispatches'), 'utf8'), 'send\n');
  assert.equal(readFileSync(join(root, 'effects'), 'utf8'), 'effect\n');
  await close();
  await first.close();
  await first.dispose();
  first = await reopenFirst();
  page = first.page;
  assert.equal((await peer.getRun({ ...scope, runId: card.runId })).turnStatus, 'dispatching');
  writeFileSync(join(root, 'release-effect'), 'release');
  await wait(
    async () => (await peer.getRun({ ...scope, runId: card.runId })).turnStatus === 'completed',
  );
  const db = new DatabaseSync(join(root, 'profile/runtime.sqlite'), { readOnly: true });
  const journal = db.prepare('SELECT id, outcome FROM tool_invocations_v2').all(),
    receipts = db.prepare('SELECT request_id, state FROM ocean_service_owner_receipts').all();
  db.close();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].outcome, 'completed');
  assert.equal(readFileSync(join(root, 'effects'), 'utf8'), 'effect\n');
  return {
    prepared,
    recovered,
    dropped,
    originalReceipt: independent('receipt', { requestId: dropped.requestId }),
    currentLost: await connection('lost'),
    granted,
    card: await peer.getDecision(ref),
    previewLength: full.length,
    journal,
    receipts,
    businessCalls: 1,
    acceptedEffects: 1,
    modelCallsObserved: readFileSync(join(root, 'peer-facts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((x) => x.kind === 'model').length,
  };
}
