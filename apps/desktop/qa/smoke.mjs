import console from 'node:console';
import process from 'node:process';
import { _electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import electron from 'electron';
const root = mkdtempSync(join(tmpdir(), 'ocean-window-'));
const dir = resolve(import.meta.dirname, '..');
const wrapper = join(root, 'test-node');
writeFileSync(wrapper, '#!/bin/sh\nexec "$TEST_NODE" --import "$TEST_PROVIDER" "$@"\n', {
  mode: 0o700,
});
let app, page;
async function launch(test) {
  const env = {
    ...process.env,
    OCEAN_DESKTOP_NODE: test ? wrapper : process.execPath,
    TEST_NODE: process.execPath,
    TEST_PROVIDER: join(dir, 'qa/provider.mjs'),
    OCEAN_TEST_LOG: join(root, 'requests'),
    DEEPSEEK_API_KEY: test ? 'test-only' : '',
  };
  app = await _electron.launch({
    executablePath: electron,
    args: [dir, '--user-data-dir=' + join(root, 'desktop'), '--ozone-platform=wayland'],
    env,
    chromiumSandbox: true,
    timeout: 20000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
}
const button = (name) => page.getByRole('button', { name, exact: true });
const title = (text) => page.getByRole('heading', { name: text, exact: true }).waitFor();
async function send(text, to) {
  if (to) await page.getByLabel('Кому').selectOption(to);
  await page.getByLabel('Сообщение', { exact: true }).fill(text);
  await button('Отправить').click();
}
async function status(word) {
  await page.locator('#feedback').filter({ hasText: word }).waitFor();
}
const requests = () => readFileSync(join(root, 'requests'), 'utf8').trim().split('\n');
try {
  await launch(false);
  await button('Создать Ocean Team').click();
  await title('Ocean Team');
  await button('Аватар @dev').click();
  await button('Клевер').click();
  await button('Фиолетовый').click();
  await button('Закрыть').click();
  await button('Настройки').click();
  await page.getByLabel('Тема').selectOption('light');
  await button('Бирюзовый').click();
  await button('Закрыть настройки').click();
  await button('Профили ботов').click();
  await page.getByLabel('Идентификатор').fill('docs');
  await page.getByLabel('Имя', { exact: true }).fill('Docs');
  await page.getByLabel('Роль').fill('Writer');
  await button('Создать').click();
  await button('Создать комнату').click();
  await page.getByLabel('Название').fill('Editors');
  for (const b of ['@docs', '@review']) await page.getByRole('checkbox', { name: b }).check();
  await button('Создать').click();
  await title('Editors');
  await button('Ocean Team').click();
  await send('qualification', 'dev');
  await status('Провайдер недоступен');
  console.log('Real CLI: provider_unavailable');
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  assert.equal(
    await page.evaluate(
      async () => (await globalThis.ocean.request({ op: 'rooms', argv: ['demo'] })).ok,
    ),
    false,
  );
  await app.close();
  await launch(true);
  await button('Ocean Team').click();
  await title('Ocean Team');
  await button('Настройки').click();
  assert.equal(await page.getByLabel('Тема').inputValue(), 'light');
  assert.equal(await button('Бирюзовый').getAttribute('aria-pressed'), 'true');
  await page.getByLabel('Тема').selectOption('dark');
  await button('Синий').click();
  await button('Закрыть настройки').click();
  await button('Аватар @dev').click();
  assert.equal(await button('Клевер').getAttribute('aria-pressed'), 'true');
  assert.equal(await button('Фиолетовый').getAttribute('aria-pressed'), 'true');
  await button('Сбросить').click();
  await button('Закрыть').click();
  await button('Создать комнату').click();
  await page.getByLabel('Тип').selectOption('direct');
  await page.getByRole('radio', { name: '@dev' }).check();
  await button('Создать').click();
  await title('@dev');
  await send('private-only');
  await status('completed');
  await button('Ocean Team').click();
  await send('implement', 'dev');
  await status('completed');
  assert.match(
    await page.locator('#history article').last().innerText(),
    /@dev[\s\S]*Test provider/,
  );
  await send('inspect', 'review');
  await status('completed');
  assert.match(
    await page.locator('#history article').last().innerText(),
    /@review[\s\S]*Test provider/,
  );
  assert.equal(requests().length, 3);
  assert.match(requests()[2], /Test provider · implement/);
  assert.doesNotMatch(requests()[2], /private-only/);
  await send('slow-turn', 'dev');
  for (let i = 0; i < 100 && requests().length < 4; i++) await setTimeout(50);
  assert.equal(requests().length, 4);
  await button('Запросить отмену').click();
  await status('uncertain');
  assert.doesNotMatch(await page.locator('#feedback').innerText(), /cancelled/);
  await app.close();
  await launch(true);
  await button('Ocean Team').click();
  await page.locator('#history').getByText('Test provider · inspect', { exact: false }).waitFor();
  assert.doesNotMatch(await page.locator('#history').innerText(), /private-only/);
  await page.locator('aside.details').getByText('uncertain', { exact: true }).waitFor();
  await button('@dev').click();
  await page.locator('#history').getByText('private-only', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('#history').innerText(), /implement|inspect/);
  console.log(
    'Window: explicit dev → review, private context, cancellation with uncertain runtime outcome and restart passed',
  );
} catch (error) {
  console.error(
    (
      await page
        ?.locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '')
    )?.slice(-1200),
  );
  throw error;
} finally {
  await app?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
