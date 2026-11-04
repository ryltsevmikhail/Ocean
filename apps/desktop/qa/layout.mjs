/* eslint-disable no-undef -- page.evaluate callbacks run in the renderer, not in Node. */
// CURRENT real Wayland GUI regression for RC2: with Details open the composer textarea and Send
// must be enabled, inside the viewport, uncovered by the details panel and usable at the three
// acceptance widths. Uses only a private synthetic fixture and the deterministic provider.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';
import { createLayoutDriver } from './layout-drive.mjs';
import { fileSHA256 } from './layout-measure.mjs';

const WIDTHS = [1024, 1280, 1920];
const HEIGHT = 800;
const MIB = 1024 * 1024;
assert.ok(process.env.OCEAN_QA_CLI, 'explicit built CLI required');
const f = await fixture({ root: process.env.OCEAN_QA_ROOT, preserve: true });
console.log('FIXTURE', f.root);
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
const evidence = { widths: WIDTHS, height: HEIGHT, steps: [], measurements: [], screenshots: [] };
let gui;
try {
  const dev = f.command('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Fixture');
  const review = f.command(
    'bot',
    'add',
    '--handle',
    'review',
    '--name',
    'Review',
    '--role',
    'Fixture',
  );
  const pro = f.command(
    'bot',
    'add',
    '--handle',
    'pro',
    '--name',
    'Pro',
    '--role',
    'Text',
    '--model',
    'deepseek-v4-pro',
  );
  const room = f.command(
    'room',
    'group',
    '--name',
    'Audit QA',
    '--bot',
    dev.data.id,
    '--bot',
    review.data.id,
  ).data.id;
  f.command('room', 'direct', '--bot', pro.data.id);
  // Long, scrollable history: 24 recorded notes without any provider dispatch.
  for (let index = 1; index <= 24; index++)
    f.command('send', room, '--text', 'seed-message-' + index);
  gui = await currentWindow(f, 'layout');
  const page = gui.page;
  page.setDefaultTimeout(20_000);
  const driver = createLayoutDriver({ page, root: f.root, evidence, height: HEIGHT });
  assert.equal(driver.requestCount(), 0, 'seeded notes never reach the provider');
  await page.getByRole('button', { name: 'Audit QA', exact: true }).click();
  await page.getByRole('heading', { name: 'Audit QA', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#history article').length === 24);
  const initialSilenced = await page.evaluate(
    () => document.querySelectorAll('#history article[aria-live="off"]').length,
  );
  assert.equal(initialSilenced, 24, 'the loaded batch is announced as existing history');

  // Required widths with Details open: visible, enabled, uncovered, real click send.
  for (const width of WIDTHS) {
    await driver.resize(width);
    await driver.setDetails(true);
    await driver.sendByClick(width, 'layout-open-' + width);
    const measured = await driver.measure(width, 'details-open');
    assert.equal(measured.history.scrollable, true, 'long history is scrollable');
    assert.equal(measured.history.pinned, true, 'history stays pinned to the newest message');
    await driver.screenshot('01-details-open-' + width);
    evidence.steps.push({
      step: 'details-open-send',
      width,
      requests: driver.requestCount(),
      columns: measured.columns,
      detailsPosition: measured.details.position,
      sendDisabled: measured.controls.send.disabled,
      hitSend: measured.hits.send,
    });
  }

  // Same widths with Details closed: composer reachable and Enter sends with focus restore.
  for (const width of WIDTHS) {
    await driver.resize(width);
    await driver.setDetails(false);
    await driver.sendByEnter(width, false, 'layout-enter-' + width);
    const measured = await driver.measure(width, 'details-closed');
    assert.equal(measured.rects.details, null, 'no details panel while closed');
    await driver.screenshot('02-details-closed-' + width);
    evidence.steps.push({
      step: 'details-closed-enter',
      width,
      requests: driver.requestCount(),
      columns: measured.columns,
      hitSend: measured.hits.send,
    });
  }

  // Long history/draft: a real draft survives a resize with Details open, composer stays usable.
  await driver.resize(1024);
  await driver.setDetails(true);
  const draft = 'Черновик, который сохраняется при изменении ширины';
  await page.getByLabel('Сообщение', { exact: true }).fill(draft);
  const kept = await driver.measure(1024, 'details-open', draft);
  assert.equal(kept.history.scrollable, true);
  assert.equal(kept.history.pinned, true);
  await driver.resize(1280);
  const resized = await driver.measure(1280, 'details-open', draft);
  assert.equal(resized.controls.textarea.value, draft, 'draft survives a live resize');
  await driver.resize(1024);
  await page.getByLabel('Сообщение', { exact: true }).fill('');
  evidence.steps.push({
    step: 'long-history-draft',
    width: 1024,
    historyScrollHeight: kept.history.scrollHeight,
    pinned: kept.history.pinned,
    resizedWidth: resized.viewport.width,
  });

  // Announcement semantics of the pinned log survive (role/aria-live, initial suppression).
  const announced = await page.evaluate(() => {
    const history = document.querySelector('#history');
    return {
      role: history.getAttribute('role'),
      live: history.getAttribute('aria-live'),
      relevant: history.getAttribute('aria-relevant'),
      initialSilenced: document.querySelectorAll('#history article[aria-live="off"]').length,
      liveArticles: document.querySelectorAll('#history article:not([aria-live])').length,
    };
  });
  assert.deepEqual(announced, {
    role: 'log',
    live: 'polite',
    relevant: 'additions',
    initialSilenced,
    // Six sends in this run added one user message and one answer each.
    liveArticles: 12,
  });
  evidence.steps.push({ step: 'announcement', ...announced });

  // Shift+Enter keeps native newline input and never submits.
  const beforeShift = driver.requestCount();
  await page.getByLabel('Сообщение', { exact: true }).fill('shift-line');
  await page.getByLabel('Сообщение', { exact: true }).press('Shift+Enter');
  await page.getByLabel('Сообщение', { exact: true }).pressSequentially('second');
  assert.equal(driver.requestCount(), beforeShift, 'Shift+Enter never submits');
  assert.equal(
    await page.getByLabel('Сообщение', { exact: true }).inputValue(),
    'shift-line\nsecond',
  );
  await page.getByLabel('Сообщение', { exact: true }).fill('');
  evidence.steps.push({ step: 'shift-enter-newline', requests: driver.requestCount() });

  // Attachment limits at a real width: four files total, 10 MiB each, explicit refusals.
  await driver.resize(1280);
  await driver.setDetails(false);
  const attach = page.locator('#composer input[type=file]');
  const small = (name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('qa') });
  const cardCount = () => page.locator('#composer .attachment-card').count();
  const alertText = async () => (await page.locator('#composer [role="alert"]').innerText()).trim();
  await attach.setInputFiles([1, 2, 3, 4, 5].map((n) => small('five-' + n + '.txt')));
  assert.match(await alertText(), /до четырёх файлов/);
  assert.equal(await cardCount(), 0);
  await attach.setInputFiles([
    {
      name: 'oversize.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(MIB * 10 + 1),
    },
  ]);
  assert.match(await alertText(), /не более 10 МБ/);
  assert.equal(await cardCount(), 0);
  await attach.setInputFiles([
    { name: 'limit.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(MIB * 10, 7) },
  ]);
  await page.getByRole('button', { name: 'Убрать limit.bin' }).waitFor();
  await attach.setInputFiles([small('a.txt'), small('b.txt'), small('c.txt')]);
  await page.getByRole('button', { name: 'Убрать c.txt' }).waitFor();
  assert.equal(await cardCount(), 4);
  const attachButton = page.getByRole('button', { name: 'Прикрепить файл', exact: true });
  assert.equal(await attachButton.isDisabled(), true, 'attach control disables at four files');
  await driver.screenshot('03-attachment-limits');
  while ((await cardCount()) > 0)
    await page.locator('#composer .attachment-card button[aria-label^="Убрать "]').first().click();
  assert.equal(await cardCount(), 0);
  evidence.steps.push({
    step: 'attachment-limits',
    fileLimit: 4,
    perFileMiB: 10,
    refusedFive: true,
    refusedOversize: true,
    acceptedBoundary: true,
  });

  // Text-only model: real image preview/export bytes and a visible pre-dispatch refusal.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const sourcePath = join(f.root, 'diagram.png');
  writeFileSync(sourcePath, png);
  await page.getByRole('button', { name: '@pro', exact: true }).click();
  await page.getByRole('heading', { name: '@pro', exact: true }).waitFor();
  await attach.setInputFiles([sourcePath]);
  const preview = page.getByRole('button', { name: 'Предпросмотр diagram.png' });
  await preview.waitFor();
  await preview.click();
  await page.getByRole('dialog', { name: 'diagram.png' }).getByRole('img').waitFor();
  const exported = join(f.root, 'exports', 'diagram.png');
  await page.getByRole('button', { name: 'Сохранить оригинал' }).click();
  for (let i = 0; i < 100 && !existsSync(exported); i++)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  assert.equal(fileSHA256(exported), fileSHA256(sourcePath), 'exported original bytes unchanged');
  await page.getByRole('button', { name: 'Закрыть предпросмотр' }).click();
  const note = await page.locator('#composer .attachment-note').innerText();
  assert.match(note, /не принимает изображения/);
  const beforeRefusal = driver.requestCount();
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page
    .locator('#feedback')
    .getByText(/не принимает изображения/)
    .waitFor();
  assert.equal(driver.requestCount(), beforeRefusal, 'capability refusal dispatches nothing');
  await driver.screenshot('04-image-capability-refusal');
  await page.locator('#composer .attachment-card button[aria-label^="Убрать "]').first().click();
  evidence.steps.push({
    step: 'image-capability-refusal',
    hint: note,
    exportedSHA256: fileSHA256(exported),
    requests: driver.requestCount(),
  });

  // Actual userData/sandbox preferences from the native main process (also asserted by currentWindow).
  const native = readFileSync(join(f.root, 'native.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const preferences = native.filter((entry) => entry.webPreferences).at(-1).webPreferences;
  assert.equal(
    native.some((entry) => entry.userData === gui.userData),
    true,
  );
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(existsSync(join(f.root, 'page-errors.log')), false, 'no renderer page errors');
  evidence.userData = { path: gui.userData, preferences };

  writeFileSync(join(f.root, 'layout-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(
    'LAYOUT GUI QUALIFIED',
    JSON.stringify({
      steps: evidence.steps.map((step) => step.step + '@' + (step.width ?? '')),
      screenshots: evidence.screenshots.length,
      requests: driver.requestCount(),
      fixture: f.root,
    }),
  );
  await gui.close();
  gui = undefined;
} catch (error) {
  evidence.failure ??= { message: String(error?.stack ?? error) };
  writeFileSync(join(f.root, 'layout-evidence.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(join(f.root, 'layout-failure.txt'), String(error?.stack ?? error));
  if (gui) {
    await gui.page
      .screenshot({ path: join(f.root, 'failure.png') })
      .catch((failure) => (evidence.failure.screenshot = String(failure)));
  }
  console.error(error);
  throw error;
} finally {
  await gui?.dispose();
  await f.close();
}
