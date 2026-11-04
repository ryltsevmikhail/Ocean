/* eslint-disable no-undef -- page.evaluate callbacks run in the renderer, not in Node. */
// CURRENT real Wayland GUI qualification for runtime-owned provider settings.
// Uses only a private synthetic fixture (synthetic HOME/XDG, fixture provider transport).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';

assert.ok(process.env.OCEAN_QA_CLI, 'explicit built CLI required');
const f = await fixture({ root: process.env.OCEAN_QA_ROOT, preserve: true, modelLog: true });
console.log('FIXTURE', f.root);
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
const readCredentialFile = () => {
  const path = join(f.profile + '.credentials', 'providers.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const KEY_ONE = 'sk-gui-fixture-provider-key-one';
const KEY_TWO = 'sk-gui-fixture-provider-key-two';
const KEY_THREE = 'sk-gui-fixture-provider-key-three';
let gui;
const evidence = { steps: [], console: [], screenshots: [] };
try {
  gui = await currentWindow(f, 'provider-settings');
  const page = gui.page;
  page.on('console', (message) => evidence.console.push(message.type() + ':' + message.text()));
  const status = async () => {
    const reply = await page.evaluate(() => globalThis.ocean.request({ op: 'provider' }));
    assert.equal(reply.ok, true);
    return reply.data;
  };
  const initial = await status();
  assert.equal(initial.source, 'external');
  assert.equal(initial.state, 'connected');
  assert.equal(initial.savedKey, false);
  assert.equal(JSON.stringify(initial).includes('fixture-only'), false);
  evidence.steps.push({ step: 'initial-status', status: initial });

  await page.getByRole('button', { name: 'Провайдер' }).click();
  const dialog = page.getByRole('dialog', { name: 'Провайдер' });
  await dialog.waitFor();
  const focused = await page.evaluate(() => {
    const dialogElement = document.querySelector('dialog.provider-panel');
    return dialogElement?.contains(document.activeElement) ?? false;
  });
  assert.equal(focused, true, 'focus stays inside the provider dialog');
  const statusLine = dialog.locator('.info-card');
  await statusLine.getByText(/Ключ окружения/).waitFor();
  evidence.steps.push({ step: 'opened-settings', statusLine: await statusLine.innerText() });

  const key = dialog.getByLabel('Ключ API');
  await key.fill(KEY_ONE);
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await statusLine.getByText(/Ключ Ocean/).waitFor();
  assert.equal(await key.inputValue(), '', 'masked transient input is cleared after submit');
  const saved = await status();
  assert.equal(saved.source, 'saved');
  assert.equal(saved.savedKey, true);
  const credential = readCredentialFile();
  const refs = Object.keys(credential?.secrets ?? {});
  assert.equal(refs.length, 1);
  assert.equal(credential.secrets[refs[0]].key, KEY_ONE);
  const credentialMode = statSync(f.profile + '.credentials').mode & 0o777;
  const fileMode = statSync(join(f.profile + '.credentials', 'providers.json')).mode & 0o777;
  assert.equal(credentialMode, 0o700);
  assert.equal(fileMode, 0o600);
  evidence.steps.push({ step: 'saved-key', credentialMode, fileMode, refs, status: saved });

  await page.screenshot({ path: join(f.root, '01-provider-saved.png') });
  evidence.screenshots.push(join(f.root, '01-provider-saved.png'));

  await dialog.getByRole('button', { name: 'Проверить' }).click();
  await dialog
    .locator('.check-line')
    .getByText(/Список моделей получен/)
    .waitFor();
  const checked = await status();
  assert.equal(checked.lastCheck?.outcome, 'ok');
  assert.equal(checked.lastCheck?.modelSupported, true);
  evidence.steps.push({ step: 'checked', lastCheck: checked.lastCheck });

  await key.fill(KEY_TWO);
  await dialog.getByRole('button', { name: 'Заменить' }).click();
  await page.getByText(/Ключ сохранён/).waitFor();
  assert.equal(await key.inputValue(), '');
  const rotated = readCredentialFile();
  const rotatedRefs = Object.keys(rotated.secrets);
  assert.equal(rotatedRefs.length, 1);
  assert.equal(rotated.secrets[rotatedRefs[0]].key, KEY_TWO);
  const replaced = await status();
  assert.equal(replaced.revision, checked.revision + 1);
  evidence.steps.push({ step: 'replaced-key', revision: replaced.revision, rotatedRefs });

  // A concurrent owner request moves the revision: the open dialog must fail safely with a
  // mapped text error (no key, no vendor text) and never overwrite the newer configuration.
  const peer = await connectLocalRuntime({ profile: f.profile });
  try {
    await peer.providerSet({
      requestId: crypto.randomUUID(),
      key: KEY_THREE,
      model: 'deepseek-flash',
    });
  } finally {
    peer.close();
  }
  await dialog.getByRole('button', { name: 'Удалить сохранённый ключ' }).click();
  const conflict = dialog.getByRole('alert');
  await conflict.waitFor();
  const conflictText = await conflict.innerText();
  assert.ok(conflictText.length > 0);
  for (const secret of [KEY_ONE, KEY_TWO, KEY_THREE])
    assert.equal(conflictText.includes(secret), false);
  evidence.steps.push({ step: 'stale-revision-error', text: conflictText });
  await page.screenshot({ path: join(f.root, '02-provider-error.png') });
  evidence.screenshots.push(join(f.root, '02-provider-error.png'));
  await dialog.getByRole('button', { name: 'Закрыть провайдера' }).click();
  await page.getByRole('button', { name: 'Провайдер' }).click();
  await statusLine.getByText(/Ключ Ocean/).waitFor();
  const refreshed = await status();
  assert.equal(refreshed.savedKey, true);
  assert.equal(refreshed.revision, replaced.revision + 1);
  evidence.steps.push({ step: 'refreshed-after-conflict', revision: refreshed.revision });

  await dialog.getByRole('button', { name: 'Отключить' }).click();
  await statusLine.getByText(/Отключено/).waitFor();
  const disconnected = await status();
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.source, 'none');
  evidence.steps.push({ step: 'disconnected', status: disconnected });

  await dialog.getByRole('button', { name: 'Удалить сохранённый ключ' }).click();
  await statusLine.getByText(/Ключ окружения/).waitFor();
  const removed = await status();
  assert.equal(removed.source, 'external');
  assert.equal(removed.savedKey, false);
  const emptied = readCredentialFile();
  assert.deepEqual(Object.keys(emptied.secrets), []);
  evidence.steps.push({ step: 'removed-saved-key', status: removed });

  // Bot creation uses the status model list and defaults to the selected model.
  await dialog.getByRole('button', { name: 'Закрыть провайдера' }).click();
  await page.getByRole('button', { name: 'Локальный профиль' }).click();
  await page.getByRole('button', { name: 'Профили ботов' }).click();
  const manager = page.getByRole('dialog', { name: 'Создание' });
  await manager.getByText('НОВЫЙ БОТ').waitFor();
  const modelSelect = manager.getByLabel('Модель');
  const modelOptions = await modelSelect.locator('option').allTextContents();
  const modelValue = await modelSelect.inputValue();
  assert.deepEqual(
    modelOptions.map((text) => text.split(' ')[0]),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.equal(modelValue, removed.model);
  evidence.steps.push({ step: 'bot-model-list', modelOptions, modelValue });
  await manager.getByRole('button', { name: 'Закрыть' }).click();

  // Readable error state: the runtime refuses an unknown model with a stable code only.
  const refusal = await page.evaluate(() =>
    globalThis.ocean.request({
      op: 'provider-set',
      requestId: crypto.randomUUID(),
      model: 'deepseek-chat',
    }),
  );
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error.code, 'provider_invalid_model');
  evidence.steps.push({ step: 'stable-refusal', code: refusal.error.code });

  const keyOneVisible = await page.evaluate(
    (secrets) => {
      const text = document.body.innerText;
      const storage = JSON.stringify({ ...localStorage });
      return secrets.some((secret) => text.includes(secret) || storage.includes(secret));
    },
    [KEY_ONE, KEY_TWO, KEY_THREE],
  );
  assert.equal(keyOneVisible, false, 'no key text in UI or browser storage');
  const logText = (name) =>
    existsSync(join(f.root, name)) ? readFileSync(join(f.root, name), 'utf8') : '';
  const rendererBytes = logText('renderer-console.log');
  assert.equal(
    rendererBytes.includes(KEY_ONE) ||
      rendererBytes.includes(KEY_TWO) ||
      rendererBytes.includes(KEY_THREE),
    false,
  );
  const pageErrors = logText('page-errors.log');
  assert.equal(
    pageErrors.includes(KEY_ONE) || pageErrors.includes(KEY_TWO) || pageErrors.includes(KEY_THREE),
    false,
  );

  // No secret bytes in the authoritative database or owner logs, only metadata.
  for (const name of readdirSync(f.profile).filter((x) => x.startsWith('runtime.sqlite'))) {
    const bytes = readFileSync(join(f.profile, name));
    assert.equal(bytes.includes(Buffer.from(KEY_ONE)), false, name);
    assert.equal(bytes.includes(Buffer.from(KEY_TWO)), false, name);
    assert.equal(bytes.includes(Buffer.from(KEY_THREE)), false, name);
  }
  const ownerLog = logText('owner.log');
  assert.equal(
    ownerLog.includes(KEY_ONE) || ownerLog.includes(KEY_TWO) || ownerLog.includes(KEY_THREE),
    false,
  );
  // The deterministic transport saw only bounded model discovery: no inference and no GitHub.
  const requests = readFileSync(join(f.root, 'requests'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(requests.length >= 1, 'fixture provider saw the bounded model discovery request');
  assert.equal(
    requests.every((entry) => entry.models === true),
    true,
    'no inference request in this provider-settings run',
  );
  evidence.steps.push({
    step: 'secret-boundary',
    modelProbes: requests.length,
    inferenceRequests: 0,
    sqliteFiles: readdirSync(f.profile).filter((x) => x.startsWith('runtime.sqlite')),
  });

  const identity = JSON.parse(
    execFileSync(process.execPath, ['examples/local-runtime-client.mjs', f.profile, 'status'], {
      env: f.env,
      encoding: 'utf8',
    }),
  );
  evidence.identity = identity;
  writeFileSync(join(f.root, 'provider-settings-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PROVIDER GUI QUALIFIED', JSON.stringify(evidence.steps));
  await gui.close();
} catch (error) {
  writeFileSync(join(f.root, 'provider-settings-failure.txt'), String(error?.stack ?? error));
  if (gui) await gui.dispose();
  await f.close();
  throw error;
}
await f.close();
