import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { wait } from './current-window.mjs';
import { checkReachable, fileSHA256, measureLayout } from './layout-measure.mjs';
import { saveProof } from './model-native-session.mjs';

// Query the compositor, retaining only the window for this verified Electron process.
function hypr(...args) {
  return execFileSync('hyprctl', args, {
    encoding: 'utf8',
    timeout: 2500,
    killSignal: 'SIGKILL',
    maxBuffer: 4e6,
  });
}
function client(pid) {
  const rows = JSON.parse(hypr('-j', 'clients')).filter(
    (x) => x.pid === pid && x.title === 'Ocean Desktop',
  );
  assert.equal(rows.length, 1);
  const { address, mapped, hidden, floating, size, at, monitor, xwayland } = rows[0];
  assert.match(address, /^0x[0-9a-f]+$/);
  return { pid, address, mapped, hidden, floating, size, at, monitor, xwayland };
}
// Resolve the same synthetic window again inside the compositor before acting.
function dispatch(row, action) {
  const reply = hypr(
    'eval',
    `local w=hl.get_window("address:${row.address}"); assert(w and w.pid==${row.pid}); hl.dispatch(hl.dsp.window.${action}); return "ok"`,
  );
  assert.match(reply, /ok/);
}
export async function nativeWidths(
  { page, desktop, inspectMain, fixture: { root } },
  step,
  { draftText, recipientValue = 'dev' } = {},
) {
  const original = step(() => client(desktop.pid));
  if (!original.floating) {
    step(() => dispatch(original, 'float({action="on",window=w})'));
    await step(() => wait(() => step(() => client(desktop.pid).floating), 3000));
  }
  const facts = [];
  for (const width of [1024, 1280, 1920]) {
    const owned = step(() => client(desktop.pid));
    assert.equal(owned.address, original.address);
    await step(() => inspectMain('win.setBounds({width:' + width + ',height:800})'));
    await step(() => setTimeout(350));
    const size = step(() => client(desktop.pid)).size;
    if (size[0] !== width || size[1] !== 800) {
      step(() => dispatch(owned, 'resize({x=' + width + ',y=800,relative=false,window=w})'));
      await step(() => setTimeout(350));
    }
    step(() => dispatch(owned, 'center({window=w})'));
    await step(() => setTimeout(300));
    const compositor = step(() => client(desktop.pid));
    const native = await step(() =>
      inspectMain(
        '({visible:win.isVisible(),bounds:win.getBounds(),content:win.getContentBounds(),display:e.screen.getDisplayMatching(win.getBounds()).bounds, scale:e.screen.getDisplayMatching(win.getBounds()).scaleFactor})',
      ),
    );
    assert.ok(native.visible && compositor.mapped && !compositor.hidden && !compositor.xwayland);
    const details = page.getByRole('button', { name: 'Сведения', exact: true });
    if ((await step(() => details.getAttribute('aria-expanded'))) !== 'true')
      await step(() => details.click());
    const field = page.getByLabel('Сообщение', { exact: true });
    const draft = draftText ?? 'Native ' + width;
    const recipient = page.getByLabel('Кому');
    if (await step(() => recipient.count()))
      await step(() => recipient.selectOption(recipientValue));
    await step(() => field.click());
    await step(() => field.fill(draft));
    await step(() =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
          ),
      ),
    );
    const layout = await step(() => measureLayout(page));
    assert.equal(layout.controls.textarea.focused, true);
    if (draftText) {
      assert.equal(layout.history.scrollable, true);
      assert.equal(layout.history.pinned, true);
    }
    assert.deepEqual(
      checkReachable(layout, layout.viewport.width, { detailsOpen: true, draft }),
      [],
    );
    const exact =
      layout.viewport.width === width &&
      layout.viewport.height === 800 &&
      native.bounds.width === width &&
      native.bounds.height === 800 &&
      native.content.width === width &&
      native.content.height === 800 &&
      compositor.size[0] === width &&
      compositor.size[1] === 800;
    const path = join(root, 'width-' + width + '.png');
    await step(() => page.screenshot({ path }));
    facts.push({
      requested: { width, height: 800 },
      native,
      compositor,
      exact,
      layout,
      path,
      sha256: fileSHA256(path),
    });
    saveProof(root, 'bounds-' + width + '.json', facts.at(-1));
    assert.ok(exact, 'physical bounds constrained; inspect measured evidence before accepting');
  }
  return facts;
}
