import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { wait } from './current-window.mjs';
import { handoffAssets, image, files } from './model-handoff-assets.mjs';
import { button, selectRoom } from './room-task-setup.mjs';
import { saveProof } from './model-native-paths.mjs';
export async function restartAssets(s, setup, step) {
  const { peer, page } = s;
  const group = (
    await step(() =>
      peer.createGroup({
        workspaceId: 'ws_ocean',
        requestId: 'restart-assets',
        title: 'Handoff files',
        botIds: setup.bots.map((b) => b.id),
      }),
    )
  ).data.id;
  await step(() => button(page, 'Обновить').click());
  await selectRoom(page, 'Handoff files', step);
  await step(() =>
    page.locator('#composer input[type=file]').setInputFiles(files, { timeout: 60000 }),
  );
  await step(() => button(page, 'Убрать boundary.bin').waitFor({ timeout: 60000 }));
  await step(() => page.getByLabel('Сообщение', { exact: true }).fill('restart original files'));
  await step(() => page.getByLabel('Кому').selectOption(''));
  await step(() => button(page, 'Отправить').click());
  await wait(
    async () => (await step(() => page.locator('#history .attachment-card').count())) === 4,
  );
  await wait(
    async () => (await step(() => page.locator('#composer .attachment-card').count())) === 0,
  );
  const history = await step(() =>
    page.evaluate((room) => globalThis.ocean.request({ op: 'history', room, after: 0 }), group),
  );
  assert.equal(history.ok, true);
  const message = history.data.find((m) => m.body === 'restart original files');
  assert.ok(message);
  await selectRoom(page, setup.room.title, step);
  return { assetsRoom: group, message };
}
export async function ordinaryNativePhase(s, setup, step) {
  const {
      page,
      peer,
      fixture: { root },
    } = s,
    { room } = setup;
  const group = (
    await step(() =>
      peer.createGroup({
        workspaceId: 'ws_ocean',
        requestId: 'e20-files',
        title: 'Handoff files',
        botIds: setup.bots.map((b) => b.id),
      }),
    )
  ).data.id;
  for (let i = 1; i <= 24; i++)
    await step(() =>
      peer.submit({
        workspaceId: 'ws_ocean',
        roomId: group,
        requestId: 'history-' + i,
        text: 'native-history-' + i,
      }),
    );
  const message = await handoffAssets(s, group, step);
  await taskGeometry(s, setup, step);
  const direct = (
    await step(() =>
      peer.openDirect({
        workspaceId: 'ws_ocean',
        requestId: 'vision-direct',
        botId: setup.bots[0].id,
      }),
    )
  ).data.id;
  await step(() => button(page, 'Обновить').click());
  await step(() => button(page, '@a').click());
  await step(() => page.locator('#composer input[type=file]').setInputFiles(image));
  await step(() => page.getByLabel('Сообщение', { exact: true }).fill('ordinary exact vision'));
  await step(() => button(page, 'Отправить').click());
  await step(() => page.getByText('Ordinary fixture answer', { exact: true }).waitFor());
  const rows = readFileSync(join(root, 'provider.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const request = rows
    .filter((r) => r.kind === 'generation' && r.route === '/chat/completions')
    .at(-1);
  const images = request.input.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : [],
  );
  assert.equal(
    images.at(-1).image_url.url,
    'data:image/png;base64,' + image.buffer.toString('base64'),
  );
  saveProof(root, 'ordinary-vision.json', { direct, images, message, provider: rows });
  const unsupportedRoom = (
    await step(() =>
      peer.openDirect({
        workspaceId: 'ws_ocean',
        requestId: 'unsupported-direct',
        botId: setup.bots[1].id,
      }),
    )
  ).data.id;
  await step(() => button(page, 'Обновить').click());
  await step(() => button(page, '@b').click());
  await step(() => page.locator('#composer input[type=file]').setInputFiles(image));
  await step(() => page.getByLabel('Сообщение', { exact: true }).fill('unsupported exact vision'));
  await step(() => page.getByText(/не принимает изображения: отправка будет отклонена/).waitFor());
  const before = await step(() =>
    peer.history({ workspaceId: 'ws_ocean', roomId: unsupportedRoom }),
  );
  await step(() => button(page, 'Отправить').click());
  await step(() => page.getByText(/Отправка не выполнена/).waitFor());
  const after = await step(() =>
    peer.history({ workspaceId: 'ws_ocean', roomId: unsupportedRoom }),
  );
  assert.deepEqual(after, before);
  const refusedRows = readFileSync(join(root, 'provider.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(
    refusedRows.filter((r) => r.kind === 'generation').length,
    rows.filter((r) => r.kind === 'generation').length,
  );
  saveProof(root, 'unsupported-vision.json', {
    unsupportedRoom,
    before,
    after,
    provider: refusedRows,
    ui: await step(() => page.locator('body').innerText()),
  });
  await step(() => button(page, room.title).click());
  return { assetsRoom: group, message };
}
export async function taskGeometry(s, setup, step) {
  const { page, peer, fixture } = s;
  await selectRoom(page, setup.room.title, step);
  const panel = page.getByRole('dialog', { name: 'Задачи команды', exact: true });
  const draft = 'ordinary task-dialog preservation';
  const composer = page.getByLabel('Сообщение', { exact: true }),
    chips = page.locator('#composer .attachment-card');
  await step(() => composer.fill(draft));
  await step(() => page.locator('#composer input[type=file]').setInputFiles(image));
  await step(() => button(page, 'Убрать diagram.png').waitFor());
  const facts = [];
  for (const width of [1024, 1280, 1920]) {
    await step(() => s.inspectMain('win.setBounds({width:' + width + ',height:800})'));
    await wait(
      async () => (await step(() => page.evaluate(() => globalThis.innerWidth))) === width,
    );
    let own = JSON.parse(
      step(() => execFileSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', timeout: 2500 })),
    ).filter((x) => x.pid === s.desktop.pid);
    assert.equal(own.length, 1);
    const address = own[0].address;
    assert.match(address, /^0x[0-9a-f]+$/);
    step(() =>
      execFileSync(
        'hyprctl',
        [
          'eval',
          `local w=hl.get_window("address:${address}"); assert(w and w.pid==${s.desktop.pid}); hl.dispatch(hl.dsp.window.resize({x=${width},y=800,relative=false,window=w})); return "ok"`,
        ],
        { encoding: 'utf8', timeout: 2500 },
      ),
    );
    await wait(() => {
      own = JSON.parse(
        step(() => execFileSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', timeout: 2500 })),
      ).filter((x) => x.pid === s.desktop.pid);
      return own.length === 1 && own[0].size[0] === width && own[0].size[1] === 800;
    }, 5000);
    const entry = button(page, 'Задачи команды');
    await step(() => entry.focus());
    await step(() => page.keyboard.press('Enter'));
    await wait(async () => !(await step(() => button(panel, 'Новое поручение').isDisabled())));
    const support = await step(() =>
      page.evaluate(() => globalThis.ocean.request({ op: 'task-support' })),
    );
    assert.equal(support.ok, true);
    assert.equal(support.data.supported, true);
    await step(() => button(panel, 'Новое поручение').click());
    const taskText = panel.getByLabel('Текст поручения');
    const longText = 'A separate text-only task draft '.repeat(25);
    await step(() => taskText.fill(longText));
    for (const handle of ['a', 'b'])
      await step(() => panel.getByLabel('Участник @' + handle, { exact: true }).check());
    const grant = panel.getByRole('checkbox', { name: new RegExp(setup.grant.id) });
    await step(() => grant.check());
    const summary = panel.locator('form details summary');
    await step(() => summary.focus());
    await step(() => page.keyboard.press('Enter'));
    assert.equal(await step(() => panel.locator('form details').evaluate((el) => el.open)), true);
    await step(() => panel.locator('form pre').waitFor());
    assert.equal(await step(() => taskText.inputValue()), longText);
    assert.equal(await step(() => grant.isChecked()), true);
    assert.equal(await step(() => button(panel, 'Начать поручение').isEnabled()), true);
    const layout = await step(() =>
      panel.evaluate((el) => ({
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
        panel: el.getBoundingClientRect().toJSON(),
        controls: [...el.querySelectorAll('button,input,textarea')]
          .filter((x) => x.getBoundingClientRect().width)
          .map((x) => ({
            tag: x.tagName,
            label: x.closest('label')?.innerText || x.textContent,
            rect: x.getBoundingClientRect().toJSON(),
          })),
      })),
    );
    saveProof(fixture.root, 'team-form-' + width + '.json', layout);
    assert.ok(layout.panel.left >= 0 && layout.panel.right <= width);
    assert.ok(
      layout.controls.every(
        (c) => c.rect.left >= layout.panel.left && c.rect.right <= layout.panel.right,
      ),
    );
    layout.taskSupport = support;
    layout.taskStartDisabled = await step(() => button(panel, 'Новое поручение').isDisabled());
    assert.equal(layout.taskStartDisabled, false);
    layout.longTaskDraftBytes = Buffer.byteLength(longText);
    const form = panel.locator('form'),
      keyboard = [];
    const required = await step(() =>
      form.evaluate((el) =>
        [...el.querySelectorAll('textarea,input,button,summary')]
          .map((c, index) => ({
            index,
            disabled: !!c.disabled,
            width: c.getBoundingClientRect().width,
          }))
          .filter((c) => !c.disabled && c.width)
          .map((c) => c.index),
      ),
    );
    await step(() => taskText.scrollIntoViewIfNeeded());
    await step(() => taskText.focus());
    for (let i = 0; i < 24; i++) {
      const focus = await step(() =>
        form.evaluate((el) => {
          const active = globalThis.document.activeElement,
            dlg = el.closest('dialog');
          return {
            index: [...el.querySelectorAll('textarea,input,button,summary')].indexOf(active),
            label: active.closest('label')?.innerText ?? active.textContent,
            rect: active.getBoundingClientRect().toJSON(),
            dialog: dlg.getBoundingClientRect().toJSON(),
            scrollTop: dlg.scrollTop,
          };
        }),
      );
      saveProof(fixture.root, 'focus-' + width + '-' + i + '.json', focus);
      assert.ok(focus.index >= 0, 'keyboard left task form before visiting required controls');
      assert.ok(
        focus.rect.top >= focus.dialog.top && focus.rect.bottom <= focus.dialog.bottom,
        'focused task control is clipped',
      );
      keyboard.push(focus);
      if (required.every((index) => keyboard.some((k) => k.index === index))) break;
      await step(() => page.keyboard.press('Tab'));
    }
    assert.ok(required.length >= 9);
    assert.ok(required.every((index) => keyboard.some((k) => k.index === index)));
    layout.keyboard = keyboard;
    layout.requiredKeyboardIndices = required;
    await step(() => page.keyboard.press('Escape'));
    assert.equal(
      await step(() => entry.evaluate((el) => el === globalThis.document.activeElement)),
      true,
    );
    assert.equal(await step(() => composer.inputValue()), draft);
    assert.equal(await step(() => chips.count()), 1);
    const { pid, size, mapped, hidden, xwayland } = own[0];
    facts.push({
      width,
      compositor: { pid, address, size, mapped, hidden, xwayland },
      layout,
      keyboardEnter: true,
      escapeFocusReturned: true,
    });
  }
  await step(() => button(page, 'Убрать diagram.png').click());
  await step(() => composer.fill(''));
  const remaining = await step(() => Promise.all([composer.inputValue(), chips.count()]));
  assert.deepEqual(remaining, ['', 0]);
  saveProof(fixture.root, 'geometry-composer-cleanup.json', { roomId: setup.room.id, remaining });
  saveProof(fixture.root, 'team-layout.json', facts);
  assert.deepEqual((await step(() => peer.roomTaskList(setup.scope))).roots, []);
}
