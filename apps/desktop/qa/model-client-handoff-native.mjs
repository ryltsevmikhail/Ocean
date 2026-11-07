import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs, promisify } from 'node:util';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { seedModelSettings, workspaceId } from './model-native-seed.mjs';
import { currentWindow, wait } from './current-window.mjs';
import { handoffAssets, image } from './model-handoff-assets.mjs';
import { restartHandoff } from './model-handoff-restart.mjs';
import { retireHandoff, writeHandoffMarker } from './model-handoff-lifecycle.mjs';
const { values } = parseArgs({
  options: {
    'installed-root': { type: 'string' },
    desktop: { type: 'string' },
    root: { type: 'string' },
  },
});
const inputs = {
  installedRoot: values['installed-root'],
  desktopExecutable: values.desktop,
  ownerHook: join(import.meta.dirname, 'model-handoff-transport.mjs'),
};
const root = values.root;
const rows = (name) =>
  existsSync(join(root, name))
    ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse)
    : [];
const button = (page, name) => page.getByRole('button', { name, exact: true });
const s = await openModelNativeSession({ ...inputs, root });
let gui = s.desktop,
  original,
  terminal,
  terminalClosed,
  assets,
  direct,
  evidence;
const { peer, fixture } = s;
const independent = async (action, query, step) => {
  const result = await step(() =>
    promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dirname, 'model-handoff-peer.mjs'),
        inputs.installedRoot,
        fixture.profile,
        action,
        JSON.stringify(query),
      ],
      { env: fixture.env, timeout: 15000, killSignal: 'SIGKILL' },
    ),
  );
  const proof = JSON.parse(result.stdout);
  assert.notEqual(proof.pid, process.pid);
  return proof;
};
try {
  await s.runCase(async (step) => {
    const seed = await seedModelSettings(peer, { connectionCount: 2, botCount: 2, step });
    direct = (
      await step(() =>
        peer.openDirect({ workspaceId, requestId: 'handoff-direct', botId: seed.bots[1].bot.id }),
      )
    ).data.id;
    const scope = { workspaceId, roomId: direct };
    const refresh = async () => {
      await step(() => button(gui.page, 'Обновить').click());
      await wait(() => step(() => button(gui.page, 'Обновить').isEnabled()), 5000);
    };
    const send = async (text) => {
      const n = rows('receipts.jsonl').length;
      await step(() => gui.page.getByLabel('Сообщение', { exact: true }).fill(text));
      await step(() => button(gui.page, 'Отправить').click());
      await wait(() => step(() => rows('receipts.jsonl').length > n), 5000);
      return rows('receipts.jsonl').at(-1);
    };
    const settled = async (receipt) => {
      const query = { ...scope, runId: receipt.runId };
      await wait(
        async () => (await step(() => peer.getRun(query)))?.turnStatus === 'completed',
        10000,
      );
      const proof = await independent('inspect', query, step);
      assert.equal(proof.data.execution.execution.startedRequests, 1);
      assert.equal(proof.data.history.filter((m) => m.id === proof.data.result.id).length, 1);
      return proof;
    };
    await refresh();
    await step(() => button(gui.page, '@bot001').click());
    const first = await send('held-gui');
    await wait(() => step(() => rows('provider.jsonl').some((x) => x.text === 'held-gui')), 5000);
    await step(() => gui.page.screenshot({ path: join(root, 'gui-held.png') }));
    await step(() => gui.close());
    const detached = await independent('inspect', { ...scope, runId: first.runId }, step);
    assert.equal(detached.data.run.taskStatus, 'running');
    assert.equal(detached.data.result, null);
    writeHandoffMarker(root, 'release-held-gui', step);
    const completed = await settled(first);
    assert.equal(completed.data.result.body, 'Synthetic handoff: held-gui');
    const reopenRoot = join(root, 'reopen');
    mkdirSync(reopenRoot, { mode: 0o700 });
    mkdirSync(join(reopenRoot, 'exports'), { mode: 0o700 });
    gui = await step(() =>
      currentWindow(
        { ...fixture, root: reopenRoot, desktopUserData: s.desktop.userData },
        'reopened',
        inputs.desktopExecutable,
      ),
    );
    await step(() => button(gui.page, '@bot001').click());
    await step(() =>
      gui.page.locator('#history').getByText(completed.data.result.body, { exact: true }).waitFor(),
    );
    assert.equal(rows('provider.jsonl').filter((x) => x.text === 'held-gui').length, 1);
    saveProof(root, 'gui-handoff.json', {
      first,
      detached,
      completed,
      reopen: { pid: gui.pid, userData: gui.userData },
      disconnectIsCancellation: false,
      providerDispatches: 1,
    });
    writeHandoffMarker(root, 'drop-chat', step);
    await send('lost-chat-reply');
    await wait(() => step(() => rows('dropped.jsonl').length === 1), 5000);
    const lost = rows('dropped.jsonl')[0];
    await step(() =>
      gui.page
        .locator('#feedback')
        .getByText(/Исход операции неизвестен|Квитанция не подтверждена/)
        .waitFor(),
    );
    const replayInput = { ...scope, requestId: lost.requestId, text: 'lost-chat-reply' };
    const replay = await independent('replay', replayInput, step);
    assert.deepEqual(replay.data, lost);
    await step(() => button(gui.page, 'Повторить исходный запрос').click());
    await step(() =>
      gui.page.locator('#feedback').getByText('Сообщение принято', { exact: true }).waitFor(),
    );
    const recovered = await settled(lost);
    assert.equal(rows('provider.jsonl').filter((x) => x.text === 'lost-chat-reply').length, 1);
    saveProof(root, 'lost-chat.json', {
      lost,
      replayInput,
      replay,
      recovered,
      providerDispatches: 1,
    });
    terminal = step(() =>
      spawn(
        'python3',
        [
          join(import.meta.dirname, 'model-handoff-tui.py'),
          process.execPath,
          join(inputs.installedRoot, 'launch.js'),
          fixture.profile,
          direct,
          root,
        ],
        { env: fixture.env },
      ),
    );
    let err = '';
    terminal.stdout.on('data', (b) => writeFileSync(join(root, 'tui.stdout'), b, { flag: 'a' }));
    terminal.stderr.on('data', (b) => {
      err += b;
      writeFileSync(join(root, 'tui.stderr'), err);
    });
    terminalClosed = new Promise((resolve) =>
      terminal.once('close', (code, signal) => resolve({ code, signal })),
    );
    await wait(
      () =>
        step(() => {
          if (terminal.exitCode !== null) throw Error('TUI failed: ' + err);
          return (
            existsSync(join(root, 'tui-ready')) &&
            rows('provider.jsonl').some((x) => x.text === 'held-tui')
          );
        }),
      20000,
    );
    const tuiReceipt = rows('receipts.jsonl').at(-1);
    const tuiQuery = { ...scope, runId: tuiReceipt.runId };
    assert.equal((await step(() => peer.getRun(tuiQuery))).taskStatus, 'running');
    writeHandoffMarker(root, 'tui-detach', step);
    assert.equal((await step(() => terminalClosed)).code, 0, err);
    const afterTuiExit = await independent('inspect', tuiQuery, step);
    assert.equal(afterTuiExit.data.run.taskStatus, 'running');
    assert.equal(afterTuiExit.data.result, null);
    writeHandoffMarker(root, 'release-held-tui', step);
    const tuiCompleted = await settled(tuiReceipt);
    assert.equal(tuiCompleted.data.result.body, 'Synthetic handoff: held-tui');
    assert.equal(rows('provider.jsonl').filter((x) => x.text === 'held-tui').length, 1);
    saveProof(root, 'tui-handoff.json', {
      tuiReceipt,
      afterTuiExit,
      tuiCompleted,
      clientExitIsCancellation: false,
    });
    await refresh();
    const group = (
      await step(() =>
        peer.createGroup({
          workspaceId,
          requestId: 'handoff-group',
          title: 'Handoff files',
          botIds: seed.bots.map((b) => b.bot.id),
        }),
      )
    ).data.id;
    for (let i = 1; i <= 24; i++)
      await step(() =>
        peer.submit({
          workspaceId,
          roomId: group,
          requestId: 'history-' + i,
          text: 'seed-history-' + i,
        }),
      );
    const active = { ...s, ...gui, desktop: gui, fixture: { ...fixture, root: reopenRoot } };
    assets = await handoffAssets(active, group, step);
    const beforeVision = rows('provider.jsonl').length;
    await step(() => button(gui.page, '@bot001').click());
    await step(() => gui.page.locator('#composer input[type=file]').setInputFiles(image));
    const vision = await send('fixture-image-routing');
    await settled(vision);
    assert.equal(rows('provider.jsonl').length, beforeVision + 1);
    const routed = rows('provider.jsonl').at(-1);
    assert.equal(routed.images.length, 1);
    assert.equal(
      routed.images[0].image_url.url,
      'data:image/png;base64,' + image.buffer.toString('base64'),
    );
    evidence = {
      first,
      lost,
      tuiReceipt,
      vision,
      assets,
      scope,
      group,
      routed,
      history: await step(() => peer.history(scope)),
      providerRequests: rows('provider.jsonl'),
    };
    saveProof(root, 'before-restart.json', evidence);
    await step(() => gui.page.screenshot({ path: join(root, 'vision-fixture.png') }));
    await step(() => gui.close());
    await step(() => gui.dispose());
    saveProof(root, 'reopened-retirement.json', { records: gui.records() });
  });
} catch (error) {
  original = error;
  saveProof(root, 'failure.json', {
    error: String(error),
    stack: error.stack,
    body: gui.page.isClosed()
      ? 'closed'
      : await gui.page
          .locator('body')
          .innerText({ timeout: 2000 })
          .catch(() => 'unavailable'),
  });
  if (gui !== s.desktop) saveProof(root, 'reopened-failure.json', { records: gui.records() });
  throw error;
} finally {
  await retireHandoff({ terminal, terminalClosed, gui, session: s, original, root });
}
await restartHandoff(
  inputs,
  root,
  fixture,
  evidence,
  JSON.parse(readFileSync(join(root, 'identity.json'), 'utf8')).status.instanceId,
);
