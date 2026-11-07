// Supplemental single-window facts; never qualifies the separate two-window gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { wait } from './current-window.mjs';
import { handoffAssets, image } from './model-handoff-assets.mjs';
import { button } from './room-task-setup.mjs';
import { saveProof } from './model-native-paths.mjs';
export async function ordinaryNativePhase(s, setup, step) {
  const {
      page,
      peer,
      fixture: { root },
    } = s,
    { room } = setup;
  const panel = page.getByRole('dialog', { name: 'Задачи команды', exact: true });
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
  // Measure task controls at each native size, after the shared composer/chip measurements.
  const draft = 'ordinary task-dialog preservation';
  await step(() => page.getByLabel('Сообщение', { exact: true }).fill(draft));
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
    assert.equal(own.length, 1);
    assert.deepEqual(own[0].size, [width, 800]);
    const entry = button(page, 'Задачи команды');
    await step(() => entry.focus());
    await step(() => page.keyboard.press('Enter'));
    if (!(await step(() => button(panel, 'Новое поручение').isDisabled()))) {
      await step(() => button(panel, 'Новое поручение').click());
      await step(() =>
        panel.getByLabel('Текст поручения').fill('A separate text-only task draft '.repeat(25)),
      );
    }
    const layout = await step(() =>
      panel.evaluate((el) => ({
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
        panel: el.getBoundingClientRect().toJSON(),
        controls: [...el.querySelectorAll('button,input,textarea')]
          .filter((x) => x.getBoundingClientRect().width)
          .map((x) => ({
            tag: x.tagName,
            label: x.textContent || x.getAttribute('aria-label'),
            rect: x.getBoundingClientRect().toJSON(),
          })),
      })),
    );
    assert.ok(layout.panel.left >= 0 && layout.panel.right <= width);
    assert.ok(
      layout.controls.every(
        (c) => c.rect.left >= layout.panel.left && c.rect.right <= layout.panel.right,
      ),
    );
    const disabled = await step(() => button(panel, 'Новое поручение').isDisabled());
    const support = await step(() =>
      page.evaluate(() => globalThis.ocean.request({ op: 'task-support' })),
    );
    layout.taskSupport = support;
    layout.taskStartDisabled = disabled;
    await step(() => page.keyboard.press('Escape'));
    assert.equal(
      await step(() => entry.evaluate((el) => el === globalThis.document.activeElement)),
      true,
    );
    assert.equal(
      await step(() => page.getByLabel('Сообщение', { exact: true }).inputValue()),
      draft,
    );
    assert.equal(await step(() => page.locator('#composer .attachment-card').count()), 1);
    const { pid, size, mapped, hidden, xwayland } = own[0];
    facts.push({
      width,
      compositor: { pid, address, size, mapped, hidden, xwayland },
      layout,
      keyboardEnter: true,
      escapeFocusReturned: true,
    });
  }
  saveProof(root, 'team-layout.json', facts);
  // Exact ordinary eligible image route; no task envelope or attachment mutation.
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
  await step(() => button(page, room.title).click());
  return { assetsRoom: group, message };
}
