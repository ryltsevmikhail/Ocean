import { fixture, windowEnv } from './owner.mjs';
import { contextRefusal } from './send-recovery.mjs';
import { checkTransfers } from './transfers.mjs';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { _electron } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import electron from 'electron';
const f = await fixture(),
  { root } = f;
const dir = resolve(import.meta.dirname, '..');
let app, page;
async function launch(profile = f.profile) {
  const env = windowEnv({ ...f, profile });
  app = await _electron.launch({
    executablePath: electron,
    args: [dir, '--user-data-dir=' + join(root, 'desktop'), '--ozone-platform=wayland'],
    env,
    chromiumSandbox: true,
    timeout: 20000,
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 960 });
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
  const absent = join(root, 'absent');
  await launch(absent);
  await status('Профиль недоступен');
  assert.equal(existsSync(absent), false);
  assert.equal(existsSync(join(root, 'desktop', 'conversation', 'profile')), false);
  await app.close();
  await launch();
  await button('Создать Ocean Team').click();
  await title('Ocean Team');
  await button('Аватар @dev').click();
  await button('Озорной').click();
  const stage = page.locator('.character-studio[open] .stage');
  assert.equal(await page.locator('.character-studio[open] .collection svg').count(), 9);
  await page.getByLabel('Пигмент').fill('#9255fa');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(
    () => globalThis.document.querySelector('.character-studio[open] .reactions button')?.disabled,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await button('Писать').click();
  await page.waitForFunction(
    () =>
      Number(
        globalThis.document
          .querySelector('.character-studio[open] .stage .avatar')
          .shadowRoot.querySelector('[data-writing]')
          .getAttribute('opacity'),
      ) > 0,
  );
  await button('Стоп').click();
  assert.equal(await stage.locator('[data-writing]').getAttribute('opacity'), '0');
  await button('Закрыть').click();
  await button('Настройки').click();
  await page.getByLabel('Тема').selectOption('light');
  await button('Бирюзовый').click();
  await button('Закрыть настройки').click();
  await button('Локальный профиль').click();
  await page.getByText(f.command('runtime', 'status').instanceId, { exact: true }).waitFor();
  await button('Профили ботов').click();
  await page.getByLabel('Идентификатор').fill('Bad Handle');
  assert.equal(await page.getByLabel('Идентификатор').getAttribute('aria-invalid'), 'true');
  assert.equal(await button('Создать').isDisabled(), true);
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
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  assert.equal(
    await page.evaluate(
      async () => (await globalThis.ocean.request({ op: 'rooms', argv: ['demo'] })).ok,
    ),
    false,
  );
  await app.close();
  await launch();
  await button('Ocean Team').click();
  await title('Ocean Team');
  await button('Настройки').click();
  assert.equal(await page.getByLabel('Тема').inputValue(), 'light');
  assert.equal(await button('Бирюзовый').getAttribute('aria-pressed'), 'true');
  await page.getByLabel('Тема').selectOption('dark');
  await button('Синий').click();
  await button('Закрыть настройки').click();
  await button('Аватар @dev').click();
  assert.equal(await button('Озорной').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('Пигмент').inputValue(), '#9255fa');
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
  const image = Buffer.from(
    await app.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(
          globalThis.Buffer.from([
            255, 40, 20, 255, 20, 170, 255, 255, 70, 190, 50, 255, 210, 110, 50, 255,
          ]),
          { width: 2, height: 2 },
        )
        .toPNG()
        .toString('base64'),
    ),
    'base64',
  );
  await page.waitForFunction(
    () => !globalThis.document.querySelector('[aria-label="Прикрепить файл"]').disabled,
  );

  await checkTransfers(page, button, image);
  await page.locator('#composer input[type=file]').setInputFiles([
    {
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Attached design requirements'),
    },
    { name: 'design.png', mimeType: 'image/png', buffer: image },
    {
      name: 'archive.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 1, 255, 0, 4]),
    },
    { name: 'remove.txt', mimeType: 'text/plain', buffer: Buffer.from('Remove this file') },
  ]);
  await page
    .getByRole('button', { name: 'Предпросмотр design.png', exact: true })
    .locator('img')
    .waitFor();
  await page.getByRole('button', { name: 'Предпросмотр design.png', exact: true }).click();
  await page.getByRole('dialog', { name: 'design.png', exact: true }).getByRole('img').waitFor();
  await button('Закрыть предпросмотр').click();
  await button('Предпросмотр notes.md').click();
  await page
    .getByRole('dialog', { name: 'notes.md', exact: true })
    .getByText('Attached design requirements', { exact: true })
    .waitFor();
  await button('Закрыть предпросмотр').click();
  await button('Убрать remove.txt').click();
  assert.equal(await page.locator('.attached-files .attachment-card').count(), 3);
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await globalThis.ocean.request({
            op: 'attachment-preview',
            room: '../../etc',
            id: '12345678-1234-4123-8123-123456789abc',
          })
        ).ok,
    ),
    false,
  );
  await send('implement', 'dev');
  await status('completed');
  assert.equal(await page.locator('#composer .attachment-card').count(), 0);
  await page
    .locator('#history')
    .getByRole('button', { name: 'Предпросмотр design.png', exact: true })
    .locator('img')
    .waitFor();
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
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForFunction(() => !globalThis.document.querySelector('aside.details'));
  assert.equal(await page.locator('.rail').isVisible(), true);
  await page.setViewportSize({ width: 760, height: 860 });
  await button('Список комнат').waitFor();
  assert.equal(await page.locator('.rail').isVisible(), false);
  await page.getByLabel('Сообщение', { exact: true }).fill('Черновик комнаты');
  await button('Список комнат').click();
  await button('@dev').click();
  assert.equal(await page.getByLabel('Сообщение', { exact: true }).inputValue(), '');
  await button('Список комнат').click();
  await button('Ocean Team').click();
  assert.equal(
    await page.getByLabel('Сообщение', { exact: true }).inputValue(),
    'Черновик комнаты',
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await button('Задачи комнаты').waitFor();
  assert.equal(requests().length, 3);
  assert.match(requests()[1], /Attached design requirements/);
  assert.match(requests()[2], /Test provider · implement/);
  assert.doesNotMatch(requests()[2], /private-only/);
  await send('slow-turn', 'dev');
  for (let i = 0; i < 100 && requests().length < 4; i++) await setTimeout(50);
  assert.equal(requests().length, 4);
  await page.getByRole('button', { name: /Запросить отмену tr_.*\[v\d+\]/ }).click();
  await status('uncertain');
  assert.doesNotMatch(await page.locator('#feedback').innerText(), /cancelled/);
  await app.close();
  await launch();
  await button('Ocean Team').click();
  await page.locator('#history').getByText('Test provider · inspect', { exact: false }).waitFor();
  assert.doesNotMatch(await page.locator('#history').innerText(), /private-only/);
  await page
    .locator('#history')
    .getByRole('button', { name: 'Предпросмотр design.png', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'design.png', exact: true }).getByRole('img').waitFor();
  const saved = join(root, 'saved-image.png');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, saved);
  await button('Сохранить оригинал').click();
  for (let i = 0; i < 60 && !existsSync(saved); i++) await setTimeout(50);
  assert.deepEqual(readFileSync(saved), image);
  await button('Закрыть предпросмотр').click();
  await page
    .locator('#history')
    .getByRole('button', { name: 'Предпросмотр archive.bin', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'archive.bin', exact: true })
    .getByText('Для этого типа доступна карточка файла.', { exact: false })
    .waitFor();
  const binarySaved = join(root, 'saved-binary.bin');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, binarySaved);
  await button('Сохранить оригинал').click();
  for (let i = 0; i < 60 && !existsSync(binarySaved); i++) await setTimeout(50);
  assert.deepEqual(readFileSync(binarySaved), Buffer.from([0, 1, 255, 0, 4]));
  await button('Закрыть предпросмотр').click();
  await button('Задачи комнаты').click();
  await page
    .getByRole('dialog', { name: 'Задачи комнаты' })
    .getByText('uncertain', { exact: true })
    .waitFor();
  await button('К разговору').click();
  await button('@dev').click();
  await page.locator('#history').getByText('private-only', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('#history').innerText(), /implement|inspect/);
  assert.equal(await page.locator('#history .attachment-card').count(), 0);
  await contextRefusal(page, f);
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
  await f.close();
}
