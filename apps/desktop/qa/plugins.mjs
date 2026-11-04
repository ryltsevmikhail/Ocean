/* eslint-disable no-undef -- page.evaluate callbacks run in the renderer. */
// CURRENT real Wayland GUI qualification for the plugin settings view.
// Private synthetic fixture only: synthetic HOME/XDG/profile, a QA runtime owner
// with a deterministic in-process plugin transport, and a fixture credential
// reference whose value must never appear in the UI, logs or DTOs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';

assert.ok(process.env.OCEAN_QA_CLI, 'explicit built CLI required');
const canary = 'CANARY_GITHUB_PAT_QA_5c1e9';
const pluginLog = (root) => join(root, 'plugin-log.jsonl');
const f = await fixture({
  root: process.env.OCEAN_QA_ROOT,
  preserve: true,
  autoStart: false,
  ownerEntry: resolve('apps/desktop/qa/plugin-runtime-host.mjs'),
  extraEnv: { OCEAN_GITHUB_WORK_TOKEN: canary },
  ownerEnv: (root) => ({ OCEAN_QA_PLUGIN_LOG: join(root, 'plugin-log.jsonl') }),
});
await f.start();
console.log('FIXTURE', f.root);
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
const readLog = () => {
  const path = pluginLog(f.root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const counts = () => {
  const entries = readLog();
  return {
    discover: entries.filter((entry) => entry.kind === 'discover').length,
    invoke: entries.filter((entry) => entry.kind === 'invoke').length,
  };
};
const evidence = { steps: [], console: [], screenshots: [], counts: {} };
let gui;
try {
  const bot = f.command('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'reviewer');
  const review = f.command(
    'bot',
    'add',
    '--handle',
    'review',
    '--name',
    'Review',
    '--role',
    'reviewer',
  );
  const room = f.command('room', 'group', '--name', 'Team', '--bot', 'dev', '--bot', 'review');
  assert.equal(room.kind, 'room');
  assert.equal(room.data.kind, 'group');
  assert.equal(counts().discover, 0);
  evidence.steps.push({
    step: 'fixture-ready',
    roomId: room.data.id,
    bots: [bot.data.id, review.data.id],
  });

  gui = await currentWindow(f, 'plugin-settings');
  const page = gui.page;
  page.on('console', (message) => evidence.console.push(message.type() + ':' + message.text()));
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Плагины' }).click();
  const dialog = page.getByRole('dialog', { name: 'Плагины' });
  await dialog.waitFor();
  const card = dialog.locator('[data-testid=plugin-card]');
  await card.getByText(/Не установлен/).waitFor();
  assert.equal(counts().discover, 0);
  evidence.steps.push({ step: 'opened-settings', card: await card.innerText() });

  await dialog.locator('[data-testid=plugin-install]').click();
  await card.getByText(/Установлен, выключен/).waitFor();
  await dialog.getByText('Установлен github@1.0.0 (выключен).').waitFor();
  assert.equal(counts().discover, 0);
  evidence.steps.push({ step: 'installed-disabled' });
  await page.screenshot({ path: join(f.root, '01-plugin-installed.png') });
  evidence.screenshots.push(join(f.root, '01-plugin-installed.png'));

  await dialog.locator('[data-testid=plugin-enable]').click();
  await dialog.getByText('Включён github@1.0.0. Отозвано прав: 0.').waitFor();
  evidence.steps.push({ step: 'enabled' });

  await dialog.locator('[data-testid=plugin-name]').fill('work');
  await dialog.locator('[data-testid=plugin-credential]').fill('OCEAN_GITHUB_WORK_TOKEN');
  await dialog.locator('[data-testid=plugin-account]').fill('Work account');
  await dialog.locator('[data-testid=plugin-connect]').click();
  await dialog.getByText('Подключение «work» создано, поколение 1.').waitFor();
  const connectionItem = dialog.locator('[data-testid=plugin-connection-work]');
  await connectionItem.getByText(/credential: OCEAN_GITHUB_WORK_TOKEN/).waitFor();
  await connectionItem.locator('input[type=radio]').check();
  assert.equal(counts().discover, 0);
  evidence.steps.push({ step: 'connection-reference', item: await connectionItem.innerText() });
  await page.screenshot({ path: join(f.root, '02-plugin-connection.png') });
  evidence.screenshots.push(join(f.root, '02-plugin-connection.png'));

  await dialog.locator('[data-testid=plugin-consent-preview]').click();
  await dialog
    .locator('[data-testid=plugin-consent-prompt]')
    .getByText(/https:\/\/api\.githubcopilot\.com\/mcp\//)
    .waitFor();
  assert.equal(counts().discover, 0);
  evidence.steps.push({
    step: 'consent-preview',
    prompt: await dialog.locator('[data-testid=plugin-consent-prompt]').innerText(),
  });
  await dialog.locator('[data-testid=plugin-consent-confirm]').click();
  await dialog.getByText('Согласие сохранено для этого поколения подключения.').waitFor();
  assert.equal(counts().discover, 0);
  evidence.steps.push({ step: 'consented' });

  await dialog.locator('[data-testid=plugin-discover]').click();
  await dialog.getByText(/Обнаружено инструментов: 2\./).waitFor();
  assert.equal(counts().discover, 1);
  assert.equal(counts().invoke, 0);
  evidence.steps.push({ step: 'discovered', counts: counts() });
  await page.screenshot({ path: join(f.root, '03-plugin-consent-discovered.png') });
  evidence.screenshots.push(join(f.root, '03-plugin-consent-discovered.png'));

  await dialog.locator('[data-testid=plugin-bot]').selectOption(bot.data.id);
  await dialog.locator('[data-testid=plugin-repository]').fill('team/api');
  await dialog.locator('[data-testid=plugin-tools]').fill('list_issues,issue_read');
  await dialog.locator('[data-testid=plugin-ack]').check();
  await dialog.locator('[data-testid=plugin-preview-grant]').click();
  const preview = dialog.locator('[data-testid=plugin-preview]');
  await preview.waitFor();
  const previewText = await preview.innerText();
  assert.match(previewText, /Everyone in the group chat "Team"/);
  assert.match(previewText, /team\/api/);
  evidence.steps.push({ step: 'group-visibility-explanation', previewText });
  await page.screenshot({ path: join(f.root, '04-plugin-grant-preview.png') });
  evidence.screenshots.push(join(f.root, '04-plugin-grant-preview.png'));

  await dialog.locator('[data-testid=plugin-grant]').click();
  await dialog.getByText(/Право выдано: бот/).waitFor();
  const grantItem = dialog.locator('[data-testid^=plugin-grant-]').first();
  await grantItem.getByText(/действует/).waitFor();
  assert.equal(await grantItem.getAttribute('data-state'), 'active');
  evidence.steps.push({ step: 'granted', grant: await grantItem.innerText() });
  await page.screenshot({ path: join(f.root, '05-plugin-granted.png') });
  evidence.screenshots.push(join(f.root, '05-plugin-granted.png'));

  await dialog.locator('[data-testid=plugin-revoke]').click();
  await dialog.getByText('Право отозвано немедленно.').waitFor();
  await grantItem.getByText(/отозвано/).waitFor();
  assert.equal(await grantItem.getAttribute('data-state'), 'revoked');
  evidence.steps.push({ step: 'revoked', grant: await grantItem.innerText() });
  await page.screenshot({ path: join(f.root, '06-plugin-revoked.png') });
  evidence.screenshots.push(join(f.root, '06-plugin-revoked.png'));

  // A disabled plugin cannot stay enabled silently after state reload.
  await dialog.locator('[data-testid=plugin-disable]').click();
  await dialog.getByText('Выключен github@1.0.0.').waitFor();
  evidence.steps.push({ step: 'disabled' });

  // The credential VALUE never reaches the UI, renderer console or page errors.
  const dialogText = await dialog.innerText();
  const pageText = await page.evaluate(() => document.body.innerText);
  assert.equal(dialogText.includes(canary), false, 'dialog must not show the credential value');
  assert.equal(pageText.includes(canary), false, 'page must not show the credential value');
  assert.equal(JSON.stringify(evidence.console).includes(canary), false);
  const pageErrors = join(f.root, 'page-errors.log');
  if (existsSync(pageErrors))
    assert.equal(readFileSync(pageErrors, 'utf8').includes(canary), false);
  const consoleLog = join(f.root, 'renderer-console.log');
  if (existsSync(consoleLog))
    assert.equal(readFileSync(consoleLog, 'utf8').includes(canary), false);
  const finalCounts = counts();
  assert.deepEqual(finalCounts, { discover: 1, invoke: 0 });
  evidence.counts = finalCounts;
  evidence.credentialReferenceVisible = dialogText.includes('OCEAN_GITHUB_WORK_TOKEN');
  evidence.credentialValueVisible = dialogText.includes(canary);
  evidence.steps.push({
    step: 'secret-scan',
    credentialReferenceVisible: true,
    credentialValueVisible: false,
  });

  writeFileSync(
    join(f.root, 'plugin-gui-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
  await gui.close();
  gui = undefined;
  await f.stop();
  // Post-run private fixture scan: the synthetic credential value must not be at rest.
  const scan = (path) => {
    let text = '';
    for (const name of readdirSyncSafe(path)) {
      const child = join(path, name);
      try {
        if (statSafe(child)?.isDirectory()) text += scan(child);
        else text += readFileSync(child).toString('binary');
      } catch {
        /* runtime artifacts may have been removed by the owner stop */
      }
    }
    return text;
  };
  assert.equal(scan(f.root).includes(canary), false, 'fixture at-rest scan must be clean');
  console.log('PLUGIN GUI QUALIFIED');
} catch (error) {
  console.error('PLUGIN GUI FAILED', error);
  try {
    writeFileSync(join(f.root, 'plugin-gui-failure.log'), String(error?.stack ?? error));
  } catch {
    /* preserve whatever exists */
  }
  throw error;
} finally {
  if (gui) {
    try {
      await gui.close();
    } catch {
      /* best effort */
    }
  }
  await f.close();
}

function readdirSyncSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
