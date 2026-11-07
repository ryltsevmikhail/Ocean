import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import process from 'node:process';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { currentWindow, wait } from './current-window.mjs';
import { setupTask, button, selectRoom } from './room-task-setup.mjs';
import { files } from './model-handoff-assets.mjs';
import { independentTaskPhase, ordinaryNativePhase } from './room-task-independent.mjs';
import { digest } from './model-native-paths.mjs';
import { taskMcp } from './room-task-mcp.mjs';
const { values: v } = parseArgs({
  options: Object.fromEntries(
    ['installed-root', 'desktop', 'root', 'wayland-socket', 'hypr-command-socket'].map((k) => [
      k,
      { type: 'string' },
    ]),
  ),
});
for (const key of ['wayland-socket', 'hypr-command-socket']) {
  const stat = lstatSync(v[key]);
  assert.ok(stat.isSocket());
  assert.equal(stat.uid, process.getuid());
}
assert.equal(basename(v['hypr-command-socket']), '.socket.sock');
const signature = basename(dirname(v['hypr-command-socket']));
assert.match(signature, /^[a-zA-Z0-9_-]+$/);
const mapping = join(process.env.XDG_RUNTIME_DIR, 'hypr', signature);
mkdirSync(mapping, { recursive: true, mode: 0o700 });
symlinkSync(v['hypr-command-socket'], join(mapping, '.socket.sock'));
process.env.HYPRLAND_INSTANCE_SIGNATURE = signature;
process.env.WAYLAND_DISPLAY = v['wayland-socket'];
const inputs = {
  installedRoot: v['installed-root'],
  desktopExecutable: v.desktop,
  ownerHook: join(import.meta.dirname, 'room-task-transport.mjs'),
  qualificationParent: dirname(v.root),
};
const s = await openModelNativeSession({ ...inputs, root: v.root });
const { peer, page, fixture } = s;
let second, original, mcp;
const rows = () =>
  readFileSync(join(v.root, 'provider.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const independent = async (query, step) => {
  const r = await step(() =>
    promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dirname, 'room-task-peer.mjs'),
        v['installed-root'],
        fixture.profile,
        JSON.stringify(query),
      ],
      { env: fixture.env, timeout: 15000, killSignal: 'SIGKILL' },
    ),
  );
  const data = JSON.parse(r.stdout);
  assert.notEqual(data.pid, process.pid);
  return data;
};
try {
  mcp = await taskMcp(v.root);
  await s.runCase(async (step) => {
    saveProof(
      v.root,
      'qa-source-inputs.json',
      Object.fromEntries(
        ['native', 'independent', 'mcp', 'peer', 'setup', 'transport'].map((name) => {
          const path = join(import.meta.dirname, 'room-task-' + name + '.mjs');
          return [path, digest(readFileSync(path))];
        }),
      ),
    );
    saveProof(v.root, 'socket-map.json', {
      wayland: v['wayland-socket'],
      hypr: v['hypr-command-socket'],
      mapping,
    });
    const setup = await setupTask(s, mcp, step),
      { scope, room, grant } = setup;
    await ordinaryNativePhase(s, setup, step);
    saveProof(v.root, 'task-support-probe.json', {
      identity: peer.identity,
      sdkList: await step(() => peer.roomTaskList(scope)),
      gui: await step(() => page.evaluate(() => globalThis.ocean.request({ op: 'task-support' }))),
    });
    const secondRoot = join(v.root, 'second');
    mkdirSync(secondRoot, { mode: 0o700 });
    second = await step(() =>
      currentWindow(
        { ...fixture, root: secondRoot, desktopUserData: join(secondRoot, 'userData') },
        'second',
        v.desktop,
      ),
    );
    assert.notEqual(second.pid, s.desktop.pid);
    assert.notEqual(second.userData, s.desktop.userData);
    const firstStatus = await step(() => peer.status());
    const secondStatus = await step(() =>
      second.page.evaluate(() => globalThis.ocean.request({ op: 'status' })),
    );

    saveProof(v.root, 'two-windows.json', {
      first: { pid: s.desktop.pid, userData: s.desktop.userData },
      second: { pid: second.pid, userData: second.userData },
      firstStatus,
      secondStatus,
    });
    assert.equal(secondStatus.ok, true, JSON.stringify(secondStatus));
    assert.equal(secondStatus.data.instanceId, firstStatus.instanceId);
    await selectRoom(second.page, room.title, step);
    await independentTaskPhase(s, setup, independent, step);
    unlinkSync(join(v.root, 'release-b'));
    await step(() =>
      page.getByLabel('Сообщение', { exact: true }).fill('ordinary draft untouched'),
    );
    await step(() => page.locator('#composer input[type=file]').setInputFiles(files.slice(0, 3)));
    await step(() => button(page, 'Убрать archive.bin').waitFor());
    await step(() => button(page, 'Задачи команды').click());
    const panel = page.getByRole('dialog', { name: 'Задачи команды', exact: true });
    await step(() => button(panel, 'Новое поручение').click());
    await step(() =>
      panel.getByLabel('Текст поручения').fill('E20 task: delegate, wait, then one scoped effect'),
    );
    await step(() => panel.getByLabel('Участник @b', { exact: true }).check());
    await step(() => panel.getByLabel('Участник @a', { exact: true }).check());
    for (const handle of ['a', 'b'])
      await step(() =>
        panel
          .locator('form section')
          .filter({ has: panel.getByLabel('Участник @' + handle, { exact: true }) })
          .getByLabel('Получает первый ход')
          .setChecked(handle === 'a'),
      );
    await step(() => panel.getByRole('checkbox', { name: new RegExp(grant.id) }).check());
    const formText = await step(() => panel.innerText());
    assert.match(formText, /Облако/);
    assert.match(formText, /Локально/);
    await step(() => button(panel, 'Начать поручение').click());
    let index, root;
    await wait(async () => {
      index = await step(() => peer.roomTaskList(scope));
      return index.roots.length === 2;
    });
    root = index.roots[0].rootId;
    const query = { ...scope, rootId: root };
    await wait(async () =>
      (await step(() => peer.roomTaskGet(query))).rows.some(
        (r) => r.type === 'task' && r.waitingChildId,
      ),
    );
    const held = await independent(query, step);
    assert.ok(
      held.root.rows.some(
        (r) => r.type === 'slice' && r.disposition === 'yielded' && r.resultMessageId === null,
      ),
    );
    saveProof(v.root, 'held-root.json', held);
    await step(() => button(second.page, 'Задачи команды').click());
    const other = second.page.getByRole('dialog', { name: 'Задачи команды', exact: true });
    await step(() => other.getByRole('heading', { name: new RegExp(root) }).waitFor());
    assert.equal(
      await step(() => other.getByRole('heading', { name: 'Квитанция поручения' }).count()),
      0,
    );
    await step(() => panel.getByText(/ждёт @b/).waitFor());
    saveProof(v.root, 'held-ui.json', {
      first: await step(() => panel.innerText()),
      second: await step(() => other.innerText()),
      formText,
    });
    await step(() => page.keyboard.press('Escape'));
    assert.equal(
      await step(() => page.getByLabel('Сообщение', { exact: true }).inputValue()),
      'ordinary draft untouched',
    );
    assert.equal(await step(() => page.locator('#composer .attachment-card').count()), 3);
    await step(() => s.desktop.close());
    assert.equal((await independent(query, step)).root.status, held.root.status);
    writeFileSync(join(v.root, 'release-b'), '');
    let card;
    await wait(async () => {
      card = (await step(() => peer.listDecisions(scope)))[0];
      return card?.status === 'pending';
    }, 20000);
    saveProof(v.root, 'decision-pending.json', { card, root: await independent(query, step) });
    // Reconnect a fresh real renderer to the same runtime; it has no initiating receipt.
    const reopen = join(v.root, 'reopen');
    mkdirSync(reopen, { mode: 0o700 });
    const first = await step(() =>
      currentWindow(
        { ...fixture, root: reopen, desktopUserData: join(reopen, 'userData') },
        'reopened',
        v.desktop,
      ),
    );
    try {
      await selectRoom(first.page, room.title, step);
      await step(() => button(first.page, 'Задачи команды').click());
      for (const p of [first.page, second.page]) {
        const d = p.getByRole('dialog', { name: 'Задачи команды', exact: true });
        await step(() => d.getByRole('button', { name: new RegExp(card.decisionId) }).click());
        await step(() => button(d, 'Разрешить один раз').waitFor());
      }
      saveProof(v.root, 'same-decision-ui.json', {
        first: await step(() =>
          first.page.getByRole('dialog', { name: 'Задачи команды', exact: true }).innerText(),
        ),
        second: await step(() => other.innerText()),
        card,
      });
      await step(() => button(first.page, 'Разрешить один раз').click());
      await wait(() => mcp.stats.effects === 1);
      await step(() => button(other, 'Разрешить один раз').click());
      await step(() => other.getByText(/Устаревшее решение отклонено/).waitFor());
      assert.equal(mcp.stats.effects, 1);
      assert.equal(mcp.stats.calls, 1);
      saveProof(v.root, 'stale-vote.json', {
        text: await step(() => other.innerText()),
        mcp: mcp?.stats,
        card: await step(() =>
          peer.getDecision({ ...scope, runId: card.runId, decisionId: card.decisionId }),
        ),
      });
      mcp.releaseResponse();
      await wait(
        async () => (await step(() => peer.roomTaskGet(query))).status === 'completed',
        20000,
      );
      saveProof(v.root, 'completed.json', {
        ...(await independent(query, step)),
        provider: rows(),
        mcp: mcp?.stats,
      });
    } finally {
      await first.dispose();
      saveProof(reopen, 'retirement.json', first.records());
    }
  }, 240000);
} catch (error) {
  original = error;
  saveProof(v.root, 'failure.json', {
    secondUi:
      second && !second.page.isClosed()
        ? await second.page.locator('body').innerText().catch(String)
        : null,
    ui: !page.isClosed() ? await page.locator('body').innerText().catch(String) : null,
    error: String(error),
    stack: error.stack,
    provider: rows(),
    mcp: mcp?.stats,
  });
  throw error;
} finally {
  const errors = [];
  for (const action of [() => second?.dispose(), () => s.dispose(original), () => mcp?.close()])
    try {
      await action();
    } catch (e) {
      errors.push(String(e));
    }
  saveProof(v.root, 'retirement.json', { errors, second: second?.records(), mcp: mcp?.stats });
  assert.deepEqual(errors, []);
}
