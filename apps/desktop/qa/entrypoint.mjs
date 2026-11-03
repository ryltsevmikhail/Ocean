import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import console from 'node:console';
import { chromium } from 'playwright-core';
import { fixture, windowEnv } from './owner.mjs';

const f = await fixture(),
  userData = join(f.root, 'desktop'),
  portFile = join(userData, 'DevToolsActivePort');
const peer = async (...words) =>
  JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ['examples/local-runtime-client.mjs', f.profile, ...words],
        { env: f.env },
      )
    ).stdout,
  );
let gui, tui;
async function wait(condition, ms = 10000) {
  const until = Date.now() + ms;
  do {
    if (await condition()) return;
    await setTimeout(50);
  } while (Date.now() < until);
  throw Error('qualification timeout');
}
async function launch() {
  rmSync(portFile, { force: true });
  const proc = spawn(
    'pnpm',
    [
      '--filter',
      '@ocean/desktop',
      'start',
      '--user-data-dir=' + userData,
      '--remote-debugging-port=0',
      '--ozone-platform=wayland',
    ],
    { env: windowEnv(f), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  proc.stdout.on('data', (b) => (log = (log + b).slice(-4000)));
  proc.stderr.on('data', (b) => (log = (log + b).slice(-4000)));
  const closed = new Promise((resolve) => proc.once('close', resolve));
  gui = { proc, closed };
  await wait(() => {
    if (proc.exitCode !== null) throw Error('desktop exited ' + log);
    return existsSync(portFile);
  }, 30000);
  const [port] = readFileSync(portFile, 'utf8').split('\n');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(port));
  const page =
    browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].waitForEvent('page'));
  const { promise: done, resolve } = Promise.withResolvers();
  page.once('close', resolve);
  page.setDefaultTimeout(10000);
  async function close() {
    await page.evaluate(() => globalThis.close()).catch(() => {});
    await done;
    await wait(() => proc.exitCode !== null);
    assert.equal(await closed, 0);
    gui = undefined;
  }
  return { page, close };
}
try {
  const bot = f.command('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Fixture');
  f.command('room', 'direct', '--bot', bot.data.id);
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
    'Notes',
    '--bot',
    bot.data.id,
    '--bot',
    review.data.id,
  ).data.id;

  const first = await launch();
  await first.page.getByRole('button', { name: 'Notes', exact: true }).click();
  await first.page.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
  await first.page.getByLabel('Кому').selectOption('dev');
  assert.ok((await peer('rooms')).some((r) => r.id === room));
  const drop = join(f.root, 'requests.drop'),
    hold = join(f.root, 'requests.hold-reads');
  await first.page.locator('#composer input[type=file]').setInputFiles({
    name: 'evidence.md',
    mimeType: 'text/plain',
    buffer: Buffer.from('exact fixture attachment'),
  });
  await first.page.getByRole('button', { name: 'Убрать evidence.md' }).waitFor();
  writeFileSync(drop, '');
  writeFileSync(hold, '');
  await first.page.getByLabel('Сообщение', { exact: true }).fill('detach-turn');
  await first.page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const unknown = first.page.locator('#feedback').getByText(/Квитанция не подтверждена/);
  await unknown.waitFor();
  const original = (await unknown.textContent()).match(/[a-f0-9-]{36}/)[0];
  await first.page.getByRole('button', { name: '@dev', exact: true }).click();
  await first.page.getByRole('button', { name: 'Notes', exact: true }).click();
  assert.equal(await first.page.getByLabel('Кому').inputValue(), 'dev');
  await unknown.waitFor();
  assert.ok((await unknown.textContent()).includes(original));
  const committed = await peer('resume', room, original);
  await first.page.getByRole('button', { name: 'Повторить исходный запрос' }).click();
  await first.page
    .locator('#feedback')
    .getByText('Принято · ' + committed.messageId + ' · ' + committed.runId)
    .waitFor();
  await first.page
    .locator('#feedback')
    .getByText(/Чтение runtime/)
    .waitFor();
  rmSync(hold);
  const stop = first.page.getByRole('button', { name: /Запросить отмену tr_/ });
  await stop.waitFor();
  const runId = (await stop.getAttribute('aria-label')).match(/tr_[a-zA-Z0-9_-]+/)[0];
  assert.equal(runId, committed.runId);
  const snapshot = (await peer('observe', room, runId)).snapshot;
  assert.equal(snapshot.taskStatus, 'running');
  const receipt = await peer('resume', room, snapshot.requestId);
  assert.equal(receipt.runId, runId);
  await first.page
    .locator('#feedback')
    .getByText('Принято · ' + receipt.messageId + ' · ' + runId)
    .waitFor();

  const terminal = spawn(
    'python3',
    ['apps/cli/test-fixtures/room-tui-pty.py', process.execPath, f.profile, room, 'desktop'],
    { env: f.env },
  );
  tui = terminal;
  let output = '',
    err = '';
  terminal.stdout.on('data', (b) => (output += b));
  terminal.stderr.on('data', (b) => (err += b));
  const exited = new Promise((resolve) => terminal.once('close', resolve));
  await wait(() => {
    if (terminal.exitCode !== null) throw Error(err);
    return output.includes('observing ' + runId);
  });
  await first.close();
  assert.equal((await peer('observe', room, runId)).snapshot.taskStatus, 'running');
  writeFileSync(join(f.root, 'requests.release'), 'release');
  await wait(() => terminal.exitCode !== null);
  assert.equal(await exited, 0, err);
  assert.ok(output.trimEnd().endsWith(runId));
  const result = await peer('result', room, runId);
  assert.equal(result.body, 'Test provider · detach-turn');
  assert.deepEqual(await peer('history', room, '1'), [result]);
  const again = await launch();
  await again.page.getByRole('button', { name: 'Notes', exact: true }).click();
  const answer = again.page.locator('#history').getByText(result.body, { exact: true });
  await answer.waitFor();
  assert.equal(await answer.count(), 1);
  await again.page
    .locator('#feedback')
    .getByText(new RegExp(runId + '.*completed'))
    .waitFor();
  await again.page
    .locator('#history')
    .getByRole('button', { name: 'Предпросмотр evidence.md' })
    .click();
  await again.page
    .getByRole('dialog', { name: 'evidence.md' })
    .getByText('exact fixture attachment', { exact: true })
    .waitFor();
  const count = readFileSync(join(f.root, 'requests'), 'utf8').trimEnd().split('\n').length;
  assert.equal(count, 1);
  await again.close();
  const submitted = spawn(
    process.execPath,
    ['examples/local-runtime-client.mjs', f.profile, 'submit', room, 'example-note'],
    { env: f.env },
  );
  let record = '';
  submitted.stdout.on('data', (b) => (record += b));
  submitted.stdin.end('independent note\n');
  assert.equal(await new Promise((resolve) => submitted.once('close', resolve)), 0);
  assert.equal(JSON.parse(record).runId, null);
  assert.deepEqual(await peer('resume', room, 'example-note'), JSON.parse(record));
  assert.equal((await peer('history', room, '2'))[0].body, 'independent note');
  console.log(
    'Lost acknowledgement retried same receipt',
    original,
    committed.messageId,
    'with frozen attachment; read failure shown alongside committed receipt',
  );
  console.log(
    'GUI VERIFIED pnpm start twice; simultaneous PTY + independent SDK; close during running; reopened result',
    result.id,
    'run',
    runId,
    'provider dispatches',
    count,
  );
} finally {
  if (gui && gui.proc.exitCode === null) {
    process.kill(-gui.proc.pid, 'SIGKILL');
    await gui.closed;
  }
  tui?.kill();
  await f.close();
}
