// CURRENT real Wayland GUI against an explicitly selected installed runtime.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { fixture } from './owner.mjs';
import { currentWindow, wait } from './current-window.mjs';
import { damagedPreparation } from './send-recovery.mjs';
import { currentAssets } from './current-assets.mjs';
import { currentBackup } from './current-backup.mjs';
import { currentCancellation } from './current-cancel.mjs';

assert.ok(process.env.OCEAN_QA_CLI, 'explicit installed CLI required');
const f = await fixture({ root: process.env.OCEAN_QA_ROOT, preserve: true });
console.log('FIXTURE', f.root);
// The in-process public SDK uses the same isolated registry as spawned peers.
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
writeFileSync(
  join(f.root, 'identity.json'),
  JSON.stringify(
    { cli: f.cli, profile: f.profile, env: f.env, identity: f.command('runtime', 'status') },
    null,
    2,
  ),
);
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
let gui, terminal;
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
  gui = await currentWindow(f, 'first');
  const page = gui.page;
  const guiIdentity = await page.evaluate(() => globalThis.ocean.request({ op: 'status' }));
  const sdkIdentity = await peer('status');
  assert.equal(guiIdentity.ok, true);
  assert.equal(guiIdentity.data.profileId, sdkIdentity.profileId);
  assert.equal(guiIdentity.data.instanceId, sdkIdentity.instanceId);
  writeFileSync(
    join(f.root, 'shared-identity.json'),
    JSON.stringify({ guiIdentity, sdkIdentity }, null, 2),
  );
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
  await page.getByLabel('Кому').selectOption('dev');
  assert.ok((await peer('rooms')).some((r) => r.id === room));
  const picking = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Прикрепить файл', exact: true }).click();
  await (
    await picking
  ).setFiles({
    name: 'evidence.md',
    mimeType: 'text/plain',
    buffer: Buffer.from('exact fixture attachment'),
  });
  await page.getByRole('button', { name: 'Убрать evidence.md' }).waitFor();
  writeFileSync(join(f.root, 'requests.drop'), '');
  writeFileSync(join(f.root, 'requests.hold-reads'), '');
  await page.getByLabel('Сообщение', { exact: true }).fill('detach-turn');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const unknown = page.locator('#feedback').getByText(/Квитанция не подтверждена/);
  await unknown.waitFor();
  const original = (await unknown.getAttribute('title')).match(/[a-f0-9-]{36}/)[0];
  await page.screenshot({ path: join(f.root, '01-lost-receipt.png') });
  await page.getByRole('button', { name: '@dev', exact: true }).click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  assert.equal(await page.getByLabel('Кому').inputValue(), 'dev');
  assert.ok((await unknown.getAttribute('title')).includes(original));
  const committed = await peer('resume', room, original);
  await damagedPreparation(page, f, gui.userData, room, original, committed);
  rmSync(join(f.root, 'requests.hold-reads'));
  const stop = page.getByRole('button', { name: 'Остановить ответ @dev' });
  await stop.waitFor();
  const runId = (await page.locator('#feedback p[title^="tr_"]').getAttribute('title')).match(
    /tr_[a-zA-Z0-9_-]+/,
  )[0];
  assert.equal(runId, committed.runId);
  assert.equal((await peer('observe', room, runId)).snapshot.taskStatus, 'running');
  terminal = spawn(
    'python3',
    ['apps/desktop/qa/installed-tui.py', process.execPath, f.cli, f.profile, room],
    { env: f.env },
  );
  let output = '',
    err = '';
  terminal.stdout.on('data', (b) => {
    output += b;
    writeFileSync(join(f.root, 'tui.log'), output);
  });
  terminal.stderr.on('data', (b) => {
    err += b;
    writeFileSync(join(f.root, 'tui-errors.log'), err);
  });
  const tuiExit = new Promise((resolve) => terminal.once('close', resolve));
  await wait(() => {
    if (terminal.exitCode !== null) throw Error(err);
    return output.includes('observing ' + runId);
  });
  await page.screenshot({ path: join(f.root, '02-held-generation.png') });
  await gui.close();
  gui = undefined;
  assert.equal((await peer('observe', room, runId)).snapshot.taskStatus, 'running');
  writeFileSync(join(f.root, 'requests.release'), 'release');
  await wait(() => terminal.exitCode !== null);
  assert.equal(await tuiExit, 0, err);
  const result = await peer('result', room, runId);
  assert.equal(result.body, 'Test provider · detach-turn');
  assert.deepEqual(await peer('history', room, '1'), [result]);
  gui = await currentWindow(f, 'second');
  const second = gui.page;
  await second.getByRole('button', { name: 'Notes', exact: true }).click();
  const answer = second.locator('#history').getByText(result.body, { exact: true });
  await answer.waitFor();
  assert.equal(await answer.count(), 1);
  await second
    .locator('#feedback')
    .locator('p[title^="' + runId + '"]', { hasText: '@dev ответил' })
    .waitFor();
  await second
    .locator('#history')
    .getByRole('button', { name: 'Предпросмотр evidence.md' })
    .click();
  await second
    .getByRole('dialog', { name: 'evidence.md' })
    .getByText('exact fixture attachment', { exact: true })
    .waitFor();
  await second.getByRole('button', { name: 'Закрыть предпросмотр', exact: true }).click();
  assert.equal(readFileSync(join(f.root, 'requests'), 'utf8').trimEnd().split('\n').length, 1);
  await second.screenshot({ path: join(f.root, '03-reopened-answer.png') });
  writeFileSync(
    join(f.root, 'run-proof.json'),
    JSON.stringify(
      { room, original, committed, result, providerDispatches: 1, tui: output },
      null,
      2,
    ),
  );
  const assets = await currentAssets(second, f, room);
  await second.screenshot({ path: join(f.root, '04-attachments.png') });
  await gui.close();
  gui = undefined;
  await f.stop();
  await f.start();
  gui = await currentWindow(f, 'third-after-runtime-restart');
  await gui.page.getByRole('button', { name: 'Notes', exact: true }).click();
  await gui.page
    .locator('#history')
    .getByRole('button', { name: 'Предпросмотр large.png' })
    .click();
  await gui.page.getByRole('dialog', { name: 'large.png' }).getByRole('img').waitFor();
  await gui.page.screenshot({ path: join(f.root, '05-runtime-restart-preview.png') });
  await gui.page.getByRole('button', { name: 'Закрыть предпросмотр', exact: true }).click();
  assert.deepEqual(await peer('resume', room, original), committed);
  await gui.close();
  gui = undefined;
  await f.stop();
  await currentBackup(f, room, assets);
  const cancellationRoot = await currentCancellation();
  assert.equal(existsSync(join(f.root, 'page-errors.log')), false);
  const native = readFileSync(join(f.root, 'native.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(
    native.some((x) => x.unhandledRejection || x.uncaughtException || x.renderGone),
    false,
  );
  console.log(
    'CURRENT GUI VERIFIED',
    JSON.stringify({
      root: f.root,
      room,
      runId,
      original,
      coreProviderDispatches: 1,
      assets: assets.length,
      cancellationRoot,
    }),
  );
} catch (error) {
  if (gui) {
    writeFileSync(
      join(f.root, 'failure-body.txt'),
      await gui.page
        .locator('body')
        .innerText()
        .catch(() => 'unavailable'),
    );
    await gui.page.screenshot({ path: join(f.root, 'failure.png') }).catch(() => {});
  }
  console.error(error);
  throw error;
} finally {
  await gui?.dispose();
  if (terminal && terminal.exitCode === null) {
    terminal.kill();
    await new Promise((resolve) => terminal.once('close', resolve));
  }
  if (existsSync(f.profile)) await f.close();
}
