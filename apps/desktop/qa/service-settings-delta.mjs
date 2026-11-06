// Targeted follow-up for refreshed draft/version, run facts and long-card width fixes.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './current-window.mjs';
export async function serviceSettingsDelta({ root, ready, peer, first, independent }) {
  const page = first.page,
    scope = { workspaceId: 'ws_ocean', roomId: ready.roomId };
  await first.inspectMain('win.setSize(1024, 768), true');
  await page.getByRole('button', { name: 'Service QA', exact: true }).click();
  const open = async () => {
    await page.getByRole('button', { name: 'Плагины', exact: true }).click();
    await page.getByTestId('service-save').waitFor();
  };
  const close = () => page.getByRole('button', { name: 'Закрыть сервисы', exact: true }).click();
  await open();
  await page.getByTestId('service-id').fill('delta');
  await page.getByTestId('service-name').fill('First');
  await page.getByTestId('service-url').fill(ready.endpoint);
  await page.getByTestId('service-permission').selectOption('allow');
  await page.getByTestId('service-save').click();
  const current = async () => (await peer.serviceConnections()).find((c) => c.id === 'delta');
  await wait(async () => !!(await current()));
  await page.getByTestId('service-select').selectOption('delta');
  const c = await current();
  await peer.setServiceConnection({
    requestId: 'delta-owner',
    connectionId: c.id,
    name: 'Current owner value',
    configuration: c.configuration,
    metadataPermission: 'allow',
    expectedVersions: {
      configRevision: c.configRevision,
      trustRevision: c.trustRevision,
      credentialRevision: c.credentialRevision,
    },
  });
  await page.getByTestId('service-reload').click();
  await wait(
    async () => (await page.getByTestId('service-name').inputValue()) === 'Current owner value',
  );
  await page.getByTestId('service-refresh').click();
  await wait(async () => (await current())?.readiness === 'ready');
  await page.getByTestId('service-bot').selectOption(ready.botId);
  await page.getByTestId('service-mode').selectOption('confirm');
  await page.getByTestId('service-tool').check();
  await page.getByTestId('service-grant-ack').check();
  await page.getByTestId('service-grant').click();
  await wait(async () => (await peer.serviceGrants()).length === 1);
  await close();
  await page.getByLabel('Кому').selectOption('dev');
  await page.getByLabel('Сообщение', { exact: true }).fill('targeted full operation width');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  let card;
  await wait(async () => {
    card = (await peer.listDecisions(scope))[0];
    return card?.status === 'pending';
  });
  await open();
  await page.getByTestId('service-decision-card').click();
  await page.getByTestId('service-run-facts').filter({ hasText: ready.botId }).waitFor();
  assert.match(await page.getByTestId('service-decision-detail').innerText(), /Ожидает решения/);
  const preview = await page.getByTestId('service-decision-preview').innerText();
  const observed = independent('decision', {
    ...scope,
    runId: card.runId,
    decisionId: card.decisionId,
  });
  assert.equal(preview, observed.preview);
  assert.equal(preview.length, card.previewLength);
  await page.getByTestId('service-decision-allow').scrollIntoViewIfNeeded();
  const layout = await page.getByRole('dialog', { name: 'Сервисы и плагины' }).evaluate((el) => ({
    width: el.clientWidth,
    scrollWidth: el.scrollWidth,
    scrollLeft: el.scrollLeft,
    viewport: el.ownerDocument.defaultView.innerWidth,
    left: el.getBoundingClientRect().left,
  }));
  assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
  assert.equal(layout.scrollLeft, 0);
  assert.ok(layout.left >= 0);
  await page.screenshot({ path: join(root, 'delta-1024-decision.png') });
  writeFileSync(join(root, 'full-preview.txt'), preview);
  await page.getByTestId('service-decision-allow').click();
  writeFileSync(join(root, 'release-effect'), 'release');
  await wait(
    async () => (await peer.getRun({ ...scope, runId: card.runId })).turnStatus === 'completed',
  );
  await page.getByTestId('service-decisions-reload').click();
  await page.getByTestId('service-decision-card').click();
  await page
    .getByTestId('service-run-facts')
    .filter({ hasText: 'завершён, результат в истории' })
    .waitFor();
  const terminalFacts = await page.getByTestId('service-run-facts').innerText();
  await page.screenshot({ path: join(root, 'delta-1024-result.png') });
  await page.getByTestId('service-select').selectOption('delta');
  await page.getByTestId('service-remove-key').click();
  await wait(async () => (await current())?.configRevision > c.configRevision + 1);
  await page.getByTestId('service-disconnect').click();
  await wait(async () => (await current())?.readiness === 'disconnected');
  return {
    layout,
    previewLength: preview.length,
    card: await peer.getDecision({ ...scope, runId: card.runId, decisionId: card.decisionId }),
    terminalFacts,
    current: await current(),
    effects: readFileSync(join(root, 'effects'), 'utf8'),
    refreshedDraft: 'Current owner value',
  };
}
