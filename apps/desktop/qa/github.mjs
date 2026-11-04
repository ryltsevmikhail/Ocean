/* eslint-disable no-undef -- page.evaluate callbacks run in the renderer. */
// Task 6 Desktop demonstration: the real qualified Executor transport (loopback
// GitHub-like MCP server) reached from an actual chat message, plus the durable
// operation journal rendered in the plugin panel. Private synthetic fixture only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';

assert.ok(process.env.OCEAN_QA_CLI, 'explicit built CLI required');
const canary = 'CANARY_GITHUB_PAT_TASK6_GUI_4a7e1';
const f = await fixture({
  root: process.env.OCEAN_QA_ROOT,
  preserve: true,
  autoStart: false,
  ownerEntry: resolve('apps/desktop/qa/github-runtime-host.mjs'),
  extraEnv: { OCEAN_GITHUB_WORK_TOKEN: canary },
  ownerEnv: (root) => ({ OCEAN_QA_PLUGIN_LOG: join(root, 'plugin-log.jsonl') }),
});
console.log('FIXTURE', f.root);
await f.start();
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
const logPath = join(f.root, 'plugin-log.jsonl');
const pluginLog = () => {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const counts = () => {
  const final = pluginLog()
    .filter((entry) => entry.kind === 'final')
    .at(-1);
  return final?.mcpCounts ?? null;
};
const evidence = { steps: [], screenshots: [], console: [], counts: null };
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
  const room = f.command(
    'room',
    'group',
    '--name',
    'GitHub QA',
    '--bot',
    dev.data.id,
    '--bot',
    review.data.id,
  );
  evidence.roomId = room.data.id;
  // Owner setup through the shipped CLI against the same authenticated runtime.
  f.command('plugin', 'catalog', 'install', '--plugin', 'github');
  f.command('plugin', 'catalog', 'enable', '--plugin', 'github');
  const connection = f.command(
    'plugin',
    'connections',
    'add',
    '--name',
    'work',
    '--plugin',
    'github',
    '--credential-env',
    'OCEAN_GITHUB_WORK_TOKEN',
  );
  f.command(
    'plugin',
    'connections',
    'consent',
    '--connection',
    connection.id,
    '--generation',
    '1',
    '--acknowledge-endpoint',
  );
  const discovered = f.command(
    'plugin',
    'connections',
    'discover',
    '--connection',
    connection.id,
    '--generation',
    '1',
  );
  assert.equal(discovered.connection.schemaDigest.length, 64);
  f.command(
    'plugin',
    'access',
    'grant',
    '--room',
    room.data.id,
    '--bot',
    dev.data.id,
    '--plugin',
    'github',
    '--connection',
    connection.id,
    '--repository',
    'team/api',
    '--tool',
    'issue_read',
    '--tool',
    'list_issues',
    '--acknowledge-group-visibility',
  );
  evidence.steps.push({ step: 'owner-setup', discoverTraffic: pluginLog().length });

  gui = await currentWindow(f, 'github-chat');
  const page = gui.page;
  page.on('console', (message) => evidence.console.push(message.type() + ':' + message.text()));
  page.setDefaultTimeout(20_000);
  await page.getByRole('button', { name: 'GitHub QA', exact: true }).click();
  await page.getByRole('heading', { name: 'GitHub QA', exact: true }).waitFor();
  await page.getByLabel('Кому').selectOption('dev');
  await page.getByLabel('Сообщение', { exact: true }).fill('Прочитай issue #7 из team/api');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page
    .getByText(/Composer loses focus/)
    .first()
    .waitFor();
  const toolCalls = pluginLog()
    .filter((entry) => entry.kind === 'final')
    .at(-1)?.mcpCounts;
  evidence.steps.push({ step: 'chat-answer', mcp: toolCalls ?? null });
  await page.screenshot({ path: join(f.root, '01-github-chat.png') });
  evidence.screenshots.push(join(f.root, '01-github-chat.png'));

  await page.getByRole('button', { name: 'Плагины' }).click();
  const dialog = page.getByRole('dialog', { name: 'Плагины' });
  await dialog.waitFor();
  await dialog.locator('[data-testid=plugin-operations-open]').click();
  const operations = page.getByRole('dialog', { name: 'Операции плагинов' });
  await operations.waitFor();
  const list = operations.locator('[data-testid=plugin-operations]');
  await list.getByText(/issue_read/).waitFor();
  const listText = await list.innerText();
  assert.match(listText, /Результат получен/);
  evidence.steps.push({ step: 'operation-journal', listText });
  const button = operations.locator('[data-testid^=plugin-operation-]').first();
  await button.click();
  const detail = operations.locator('[data-testid=plugin-operation-detail]');
  await detail.waitFor();
  const detailText = await detail.innerText();
  assert.match(detailText, /team\/api/);
  assert.match(detailText, /api\.githubcopilot\.com/);
  evidence.steps.push({ step: 'operation-detail', detailText });
  await page.screenshot({ path: join(f.root, '02-github-operations.png') });
  evidence.screenshots.push(join(f.root, '02-github-operations.png'));

  // Secret boundary: the reference NAME is visible, the VALUE never is.
  const dialogText = (await dialog.innerText()) + '\n' + (await operations.innerText());
  const pageText = await page.evaluate(() => document.body.innerText);
  assert.equal(dialogText.includes('OCEAN_GITHUB_WORK_TOKEN'), true);
  assert.equal(dialogText.includes(canary), false);
  assert.equal(pageText.includes(canary), false);
  assert.equal(JSON.stringify(evidence.console).includes(canary), false);
  evidence.steps.push({ step: 'secret-boundary', referenceVisible: true, valueVisible: false });

  await operations.getByRole('button', { name: 'Закрыть операции' }).click();
  await dialog.getByRole('button', { name: 'Закрыть плагины' }).click();
  writeFileSync(
    join(f.root, 'github-gui-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
  await gui.close();
  gui = undefined;
  await f.stop();
  const finalCounts = counts();
  evidence.counts = finalCounts;
  assert.equal(finalCounts?.toolCalls, 1);
  assert.equal(finalCounts?.issueRead, 1);
  const scan = (path) => {
    let text = '';
    for (const name of readdirSyncSafe(path)) {
      const child = join(path, name);
      try {
        if (statSafe(child)?.isDirectory()) text += scan(child);
        else text += readFileSync(child).toString('binary');
      } catch {
        /* runtime artifacts may be removed by owner stop */
      }
    }
    return text;
  };
  assert.equal(scan(f.root).includes(canary), false, 'fixture at-rest scan must be clean');
  writeFileSync(
    join(f.root, 'github-gui-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
  console.log('TASK6 DESKTOP QUALIFIED', JSON.stringify(finalCounts));
} catch (error) {
  console.error('TASK6 DESKTOP FAILED', error);
  try {
    writeFileSync(join(f.root, 'github-gui-failure.log'), String(error?.stack ?? error));
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
