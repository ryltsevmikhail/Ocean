import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './current-window.mjs';
import { saveProof } from './model-native-paths.mjs';
export const button = (page, name) => page.getByRole('button', { name, exact: true });
export async function selectRoom(page, title, step) {
  await wait(async () => (await step(() => page.locator('nav button').count())) > 0);
  const target = button(page, title);
  if (!(await step(() => target.isVisible())))
    await step(() => button(page, 'Список комнат').click());
  await step(() => target.click());
  await step(() => page.getByRole('heading', { name: title, exact: true }).waitFor());
}
export async function setupTask(s, mcp, step) {
  const {
    peer,
    page,
    fixture: { root },
  } = s;
  const bots = [],
    endpoint = readFileSync(join(root, 'provider-endpoint'), 'utf8');
  for (const kind of ['cloud', 'local']) {
    const connectionId = 'e20-' + kind,
      providerId = kind === 'cloud' ? 'deepseek' : 'ollama';
    const defaultModelId = kind === 'cloud' ? 'deepseek-flash' : 'qwen3:1.7b';
    await step(() =>
      peer.setModelConnection({
        connectionId,
        requestId: 'set-' + kind,
        expectedRevision: null,
        kind,
        providerId,
        endpoint: kind === 'cloud' ? 'https://api.deepseek.com' : endpoint,
        defaultModelId,
        auth: kind === 'cloud' ? 'api_key' : 'none',
        ...(kind === 'cloud' ? { key: 'synthetic-e20-only' } : {}),
      }),
    );
    assert.equal(
      (await step(() => peer.checkModelConnection({ connectionId }))).check.outcome,
      'ok',
    );
    bots.push(
      (
        await step(() =>
          peer.createBoundBot({
            workspaceId: 'ws_ocean',
            requestId: 'bot-' + kind,
            handle: kind === 'cloud' ? 'a' : 'b',
            name: kind,
            role: 'Deterministic E20 fixture',
            binding: { connectionId, modelId: defaultModelId },
          }),
        )
      ).bot,
    );
  }
  writeFileSync(join(root, 'bot-b'), bots[1].id);
  await step(() => button(page, 'Обновить').click());
  await step(() => button(page, 'Создать комнату').click());
  const creation = page.getByRole('dialog', { name: 'Создание' });
  await step(() => creation.getByLabel('Название', { exact: true }).fill('E20 native team'));
  for (const bot of bots)
    await step(() => creation.getByLabel('@' + bot.handle, { exact: true }).check());
  await step(() => button(creation, 'Создать').click());
  await step(() => page.getByRole('heading', { name: 'E20 native team', exact: true }).waitFor());
  const room = (await step(() => peer.listRooms({ workspaceId: 'ws_ocean' }))).find(
    (r) => r.title === 'E20 native team',
  );
  assert.ok(room);
  await step(() => button(page, 'Провайдер').click());
  await step(() =>
    page
      .getByLabel(/^Подключение/)
      .first()
      .selectOption('e20-local'),
  );
  await step(() => page.getByText(/active · версия \d+ · none/).waitFor());
  assert.equal(await step(() => page.getByLabel(/^Авторизация/).inputValue()), 'none');
  await step(() => button(page, 'Проверить явно').click());
  await wait(async () => !(await step(() => button(page, 'Проверить явно').isDisabled())));
  saveProof(root, 'model-ui.json', {
    text: await step(() =>
      page.getByRole('dialog', { name: 'Провайдер', exact: true }).innerText(),
    ),
    models: await step(() => peer.listModelConnections()),
    bots,
  });
  await step(() => page.keyboard.press('Escape'));
  await step(() => button(page, 'Плагины').click());
  await step(() => page.getByTestId('service-id').fill('e20-service'));
  await step(() => page.getByTestId('service-name').fill('E20 loopback MCP'));
  await step(() => page.getByTestId('service-url').fill(mcp.url.href));
  await step(() => page.getByTestId('service-permission').selectOption('allow'));
  await step(() => page.getByTestId('service-save').click());
  await wait(async () =>
    (await step(() => peer.serviceConnections())).some((c) => c.id === 'e20-service'),
  );
  await step(() => page.getByTestId('service-select').selectOption('e20-service'));
  await step(() => page.getByTestId('service-refresh').click());
  await wait(
    async () =>
      (await step(() => peer.serviceConnections())).find((c) => c.id === 'e20-service')
        ?.readiness === 'ready',
  );
  await step(() => page.getByTestId('service-bot').selectOption(bots[0].id));
  await step(() => page.getByTestId('service-mode').selectOption('confirm'));
  await step(() => page.getByTestId('service-tool').check());
  await step(() => page.getByTestId('service-grant-ack').check());
  await step(() => page.getByTestId('service-grant').click());
  await wait(async () => (await step(() => peer.serviceGrants())).length === 1);
  const grant = (await step(() => peer.serviceGrants()))[0];
  assert.equal(grant.subject.roomId, room.id);
  assert.equal(grant.subject.botId, bots[0].id);
  await step(() => button(page, 'Закрыть сервисы').click());
  saveProof(root, 'setup.json', { room, bots, grant, endpoint, mcp: mcp.url.href });
  return { room, bots, grant, scope: { workspaceId: 'ws_ocean', roomId: room.id } };
}
