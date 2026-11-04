// CURRENT real Desktop GUI qualification for authenticated image content.
// Uses a private synthetic fixture and the real runtime/credential: the
// credential is sourced only inside the spawned private subshell and is never
// read, printed or copied by this script.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers/promises';
import { currentWindow, wait } from './current-window.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const keyFile = process.env.OCEAN_LIVE_KEY_FILE;
assert.ok(keyFile && keyFile.startsWith('/'), 'OCEAN_LIVE_KEY_FILE required');
assert.ok(process.env.OCEAN_QA_CLI, 'explicit built CLI required');
const root = mkdtempSync(join(process.env.OCEAN_QA_ROOT ?? tmpdir(), 'ocean-gui-vision-'));
const folder = (name) => join(root, name);
const env = { PATH: process.env.PATH };
mkdirSync(folder('workspace'), { mode: 0o700 });
mkdirSync(folder('exports'), { mode: 0o700 });
for (const [name, key] of [
  ['home', 'HOME'],
  ['config', 'XDG_CONFIG_HOME'],
  ['data', 'XDG_DATA_HOME'],
  ['cache', 'XDG_CACHE_HOME'],
  ['state', 'XDG_STATE_HOME'],
  ['run', 'XDG_RUNTIME_DIR'],
  ['tmp', 'TMPDIR'],
]) {
  env[key] = folder(name);
  mkdirSync(env[key], { mode: 0o700 });
}
const profile = folder('profile');
const cli = resolve(process.env.OCEAN_QA_CLI);
const profileArgs = ['--profile', profile, '--json'];
function command(...words) {
  const output = execFileSync(process.execPath, [cli, ...words, ...profileArgs], {
    env,
    encoding: 'utf8',
  });
  return JSON.parse(output).data;
}
command('init', '--workspace', folder('workspace'));
const flash = command(
  'bot',
  'add',
  '--handle',
  'flash',
  '--name',
  'Flash',
  '--role',
  'vision QA',
  '--model',
  'deepseek-flash',
);
const pro = command(
  'bot',
  'add',
  '--handle',
  'pro',
  '--name',
  'Pro',
  '--role',
  'text QA',
  '--model',
  'deepseek-v4-pro',
);
command('room', 'direct', '--bot', flash.data.id);
command('room', 'direct', '--bot', pro.data.id);
const ownerLog = { text: '' };
let owner;
const evidence = { root, steps: [], screenshots: [], renderer: [] };
let gui;
function startOwner(recordDir) {
  const script = [
    'set -a',
    `. ${JSON.stringify(keyFile)}`,
    'set +a',
    'exec "$0" --import "$1" "$2" --profile "$3" --json runtime start',
  ].join('; ');
  owner = spawn(
    'bash',
    [
      '-c',
      script,
      process.execPath,
      resolve('apps/desktop/qa/vision-record-fetch.mjs'),
      cli,
      profile,
    ],
    {
      env: { ...env, OCEAN_RECORD_DIR: recordDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const add = (b) => (ownerLog.text += b);
  owner.stdout.on('data', add);
  owner.stderr.on('data', add);
}
async function stopOwner() {
  if (owner.exitCode === null) command('runtime', 'stop');
  for (let index = 0; index < 400 && owner.exitCode === null; index++) await setTimeout(50);
  assert.equal(owner.exitCode, 0, ownerLog.text.slice(-2000));
}
const diagram = readFileSync(process.env.OCEAN_QA_DIAGRAM);
const oversize = readFileSync(process.env.OCEAN_QA_OVERSIZE);
const records = join(root, 'records');
try {
  startOwner(records);
  await wait(() => ownerLog.text.includes('"ready"'), 60000);
  const f = { root, profile, env, cli, command };
  gui = await currentWindow(f, 'vision');
  const page = gui.page;
  page.setDefaultTimeout(30000);
  page.on('console', (message) => evidence.renderer.push(message.type() + ':' + message.text()));
  const composer = () => page.locator('#composer');
  const attachmentInput = () => composer().locator('input[type=file]');
  const history = () => page.locator('#history');

  await page.getByRole('button', { name: '@flash', exact: true }).click();
  await page.getByRole('heading', { name: '@flash', exact: true }).waitFor();
  // Attach the deterministic spatial/color diagram and check the capability hint.
  await attachmentInput().setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: diagram,
  });
  await page.getByRole('button', { name: 'Убрать diagram.png' }).waitFor();
  await composer()
    .getByText(/Изображения передаются модели/)
    .waitFor();
  evidence.steps.push({
    step: 'capable-hint',
    hint: await composer().locator('.attachment-note').innerText(),
  });
  await page
    .getByLabel('Сообщение', { exact: true })
    .fill(
      'Какая фигура и какого цвета в правом нижнем углу? А в левом верхнем? Ответь одной строкой.',
    );
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const answer = history().locator('article.post.bot p').first();
  await answer.waitFor({ timeout: 120000 });
  const answerText = await answer.innerText();
  assert.ok(answerText.trim().length > 0, 'visible model answer');
  evidence.steps.push({ step: 'real-vision-answer', answer: answerText });
  await page.screenshot({ path: folder('gui-answer.png'), fullPage: false });
  evidence.screenshots.push(folder('gui-answer.png'));

  // Preview and exact export of the persisted attachment are preserved.
  await history().getByRole('button', { name: 'Предпросмотр diagram.png' }).first().click();
  await page.getByRole('dialog', { name: 'diagram.png' }).getByRole('img').waitFor();
  evidence.steps.push({ step: 'preview-retained', ok: true });
  await page.getByRole('button', { name: 'Сохранить оригинал' }).click();
  const exported = join(root, 'exports', 'diagram.png');
  await wait(() => existsSync(exported), 15000);
  assert.equal(sha(readFileSync(exported)), sha(diagram));
  await page.getByRole('button', { name: 'Закрыть предпросмотр' }).click();
  evidence.steps.push({ step: 'export-exact-bytes', exportedSha256: sha(diagram) });

  // Text-only model: the capability warning and the visible runtime refusal.
  await page.getByRole('button', { name: '@pro', exact: true }).click();
  await page.getByRole('heading', { name: '@pro', exact: true }).waitFor();
  await attachmentInput().setInputFiles({
    name: 'diagram-warning.png',
    mimeType: 'image/png',
    buffer: diagram,
  });
  await composer()
    .getByText(/не принимает изображения/)
    .waitFor();
  evidence.steps.push({
    step: 'unsupported-hint',
    hint: await composer().locator('.attachment-note').innerText(),
  });
  await page.getByLabel('Сообщение', { exact: true }).fill('опиши картинку');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page
    .locator('#feedback')
    .getByText(/Выбранная модель не принимает изображения/)
    .waitFor();
  evidence.steps.push({
    step: 'visible-refusal',
    text: await page.locator('#feedback').innerText(),
  });
  assert.equal(await history().locator('article.post.bot').count(), 0);

  // Oversize image: the trusted 8192-px limit is visible before any send.
  await attachmentInput().setInputFiles({
    name: 'oversize.png',
    mimeType: 'image/png',
    buffer: oversize,
  });
  await composer().getByText(/8192/).waitFor();
  evidence.steps.push({ step: 'oversize-visible', text: await composer().innerText() });

  // No credential-shaped text anywhere the renderer can read.
  const state = await page.evaluate(() => ({
    text: globalThis.document.body.innerText,
    storage: JSON.stringify(globalThis.localStorage),
  }));
  const shape = /sk-[A-Za-z0-9_-]{8,}/;
  assert.equal(shape.test(state.text), false, 'no credential-shaped text in the DOM');
  assert.equal(shape.test(state.storage), false, 'no credential-shaped text in localStorage');
  writeFileSync(
    join(root, 'vision-gui-evidence.json'),
    JSON.stringify({ ...evidence, rendererWithoutSecrets: true }, null, 2),
    { mode: 0o600 },
  );
  await gui.close();
  gui = undefined;
  await stopOwner();
  console.log(JSON.stringify({ ok: true, evidence: folder('vision-gui-evidence.json') }));
} catch (error) {
  writeFileSync(
    join(root, 'vision-failure.log'),
    String(error) + '\n' + ownerLog.text.slice(-4000),
  );
  throw error;
} finally {
  if (gui) await gui.dispose();
  if (owner && owner.exitCode === null) owner.kill('SIGKILL');
  if (process.env.OCEAN_QA_PRESERVE !== '1') console.log('preserve fixture:', root);
}
