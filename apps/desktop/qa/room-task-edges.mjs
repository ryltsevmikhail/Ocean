import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { wait } from './current-window.mjs';
import { button } from './room-task-setup.mjs';
import { saveProof } from './model-native-paths.mjs';
export async function taskEdges(s, setup, mcp, independent, step) {
  const {
      peer,
      page,
      fixture: { root },
    } = s,
    { scope, grant } = setup;
  const panel = page.getByRole('dialog', { name: 'Задачи команды', exact: true });
  const rows = () =>
    readFileSync(join(root, 'provider.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const generations = () => rows().filter((r) => r.kind === 'generation');
  async function form(text, handles, service, selectedGrant = grant) {
    await step(() => button(panel, 'Перечитать задачи').click());
    await wait(async () => !(await step(() => button(panel, 'Новое поручение').isDisabled())));
    if (await step(() => button(panel, 'Закрыть форму').count()))
      await step(() => button(panel, 'Закрыть форму').click());
    await step(() => button(panel, 'Новое поручение').click());
    await step(() => panel.getByLabel('Текст поручения').fill(text));
    for (const handle of ['a', 'b'])
      await step(() =>
        panel
          .getByLabel('Участник @' + handle, { exact: true })
          .setChecked(handles.includes(handle)),
      );
    for (const handle of handles)
      await step(() =>
        panel
          .locator('form section')
          .filter({ hasText: 'Участник @' + handle })
          .getByLabel('Получает первый ход')
          .setChecked(handle === handles[0]),
      );
    if (service)
      await step(() => panel.getByRole('checkbox', { name: new RegExp(selectedGrant.id) }).check());
    if (service)
      assert.equal(
        await step(() =>
          panel.getByRole('checkbox', { name: new RegExp(selectedGrant.id) }).isChecked(),
        ),
        true,
      );
    saveProof(root, text.toLowerCase().replaceAll(' ', '-') + '-form.json', {
      text: await step(() => panel.innerText()),
      grants: await step(() => peer.serviceGrants()),
      connections: await step(() => peer.serviceConnections()),
    });
  }
  async function start(text) {
    const before = (await step(() => peer.roomTaskList(scope))).roots.map((r) => r.rootId);
    await step(() => button(panel, 'Начать поручение').click());
    let found;
    await wait(async () => {
      found = (await step(() => peer.roomTaskList(scope))).roots.find(
        (r) => !before.includes(r.rootId),
      );
      return !!found;
    });
    await step(() => panel.getByRole('button', { name: new RegExp(text) }).click());
    return { ...scope, rootId: found.rootId };
  }
  const baseline = { ...mcp.stats };
  // Refuse a genuinely unavailable local endpoint with no automatic cloud attempt.
  writeFileSync(join(root, 'local-unavailable'), '');
  const beforeLocal = generations();
  await form('E20 unavailable local', ['b'], false);
  const localQuery = await start('E20 unavailable local');
  await wait(
    async () =>
      (await step(() => peer.roomTaskGet(localQuery))).rows.some(
        (r) => r.type === 'slice' && ['failed', 'paused', 'uncertain'].includes(r.turnStatus),
      ),
    20000,
  );
  const local = await independent(localQuery, step);
  assert.equal(
    generations().filter((r) => r.route === '/chat/completions').length,
    beforeLocal.filter((r) => r.route === '/chat/completions').length,
  );
  assert.ok(rows().some((r) => r.kind === 'local-unavailable'));
  saveProof(root, 'local-unavailable.json', {
    local,
    beforeLocal,
    provider: rows(),
    ui: await step(() => panel.innerText()),
  });
  await step(() => panel.getByRole('button', { name: /^Остановить корень/ }).click());
  await wait(async () => (await step(() => peer.roomTaskGet(localQuery))).status === 'stopped');
  unlinkSync(join(root, 'local-unavailable'));
  await form('E20 reconnect completed', ['a'], false);
  const completedQuery = await start('E20 reconnect completed');
  await wait(
    async () => (await step(() => peer.roomTaskGet(completedQuery))).status === 'completed',
  );
  // A selected exact grant revision is revoked independently while this form stays open.
  const revokeId = 'e20-revocation-only';
  await step(() =>
    peer.setOwnerScopeGrant({
      requestId: 'e20-revocation-grant',
      expectedRevision: null,
      intent: {
        id: revokeId,
        subject: grant.subject,
        permissions: grant.permissions,
        mode: grant.mode,
        limits: grant.limits,
      },
    }),
  );
  const revokeGrant = (await step(() => peer.serviceGrants())).find((g) => g.id === revokeId);
  assert.ok(revokeGrant);
  await form('E20 revoked scope', ['a'], true, revokeGrant);
  const beforeRevoked = await step(() => peer.roomTaskList(scope)),
    sends = generations().length;
  const revoked = await step(() =>
    peer.revokeOwnerScopeGrant({
      requestId: 'e20-revoke',
      grantId: revokeGrant.id,
      expectedRevision: revokeGrant.revision,
    }),
  );
  assert.equal(
    await step(() => panel.getByRole('checkbox', { name: new RegExp(revokeGrant.id) }).isChecked()),
    true,
  );
  await step(() => button(panel, 'Начать поручение').click());
  await step(() => panel.getByText(/Поручение отклонено: approval_required/).waitFor());
  const afterRevoked = await step(() => peer.roomTaskList(scope));
  assert.deepEqual(afterRevoked, beforeRevoked);
  assert.equal(generations().length, sends);
  assert.equal(mcp.stats.effects, baseline.effects);
  assert.equal(mcp.stats.calls, baseline.calls);
  saveProof(root, 'revoked-scope.json', {
    revoked,
    beforeRevoked,
    afterRevoked,
    sends,
    counters: mcp.stats,
    ui: await step(() => panel.innerText()),
  });
  // Execute one known effect but drop its response. The runtime must retain uncertainty.
  writeFileSync(join(root, 'drop-effect-response'), '');
  const connection = (await step(() => peer.serviceConnections())).find(
    (c) => c.id === 'e20-service',
  );
  const refresh = await step(() =>
    peer.refreshServiceConnection({
      requestId: 'e20-unknown-refresh',
      connectionId: connection.id,
      expectedVersions: {
        configRevision: connection.configRevision,
        trustRevision: connection.trustRevision,
        credentialRevision: connection.credentialRevision,
      },
    }),
  );
  saveProof(root, 'unknown-refresh.json', {
    connection,
    refresh,
    after: await step(() => peer.serviceConnections()),
  });
  await form('E20 task unknown effect', ['a', 'b'], true);
  const unknownQuery = await start('E20 task unknown effect');
  let card;
  await wait(async () => {
    card = (await step(() => peer.listDecisions(scope))).find((d) => d.status === 'pending');
    return !!card;
  }, 20000);
  await wait(async () => !(await step(() => button(panel, 'Перечитать задачи').isDisabled())));
  await step(() => delay(1200));
  await step(() => panel.getByRole('button', { name: new RegExp(card.decisionId) }).click());
  await step(() => button(panel, 'Разрешить один раз').click());
  await wait(
    async () =>
      (await step(() => peer.roomTaskGet(unknownQuery))).rows.some((r) => r.hold === 'unknown'),
    20000,
  );
  const unknown = await independent(unknownQuery, step);
  saveProof(root, 'unknown-observed.json', unknown);
  assert.equal(mcp.stats.effects, baseline.effects + 1);
  assert.equal(mcp.stats.calls, baseline.calls + 1);
  await step(() => panel.getByText(/uncertain \/ reconciling.*unknown/).waitFor());
  await step(() => panel.getByRole('button', { name: /^Остановить корень/ }).click());
  await wait(async () => (await step(() => peer.roomTaskGet(unknownQuery))).status === 'stopped');
  await step(() => panel.getByText(/Корень остановлен; очистка/).waitFor());
  const stopped = await independent(unknownQuery, step);
  assert.ok(stopped.root.rows.some((r) => r.type === 'slice' && r.turnStatus !== 'completed'));
  saveProof(root, 'unknown-stop.json', {
    baseline,
    unknown,
    stopped,
    counters: mcp.stats,
    ui: await step(() => panel.innerText()),
  });
  return {
    unknownQuery,
    stopped: await independent(unknownQuery, step),
    localQuery,
    completedQuery,
  };
}
