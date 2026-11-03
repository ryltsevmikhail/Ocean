import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';

// A refused uncertain cancellation retains evidence in its own fixture; it must
// not be force-retired to turn a failed public backup into an offline success.
export async function currentCancellation() {
  const f = await fixture({ root: process.env.OCEAN_QA_ROOT, preserve: true });
  Object.assign(process.env, f.env);
  let gui;
  try {
    const bot = f.command('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Fixture');
    const room = f.command('room', 'direct', '--bot', bot.data.id).data.id;
    gui = await currentWindow(f, 'explicit-cancel');
    const page = gui.page;
    await page.getByRole('button', { name: '@dev', exact: true }).click();
    await page.getByLabel('Сообщение', { exact: true }).fill('slow-turn');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    const cancel = page.getByRole('button', { name: 'Остановить ответ @dev' });
    await cancel.waitFor();
    const cancelLabel = await cancel.getAttribute('aria-label');
    const binding = await page.locator('#feedback p[title^="tr_"]').getAttribute('title');
    await cancel.click();
    await page.locator('#feedback').filter({ hasText: 'Исход ответа не подтверждён' }).waitFor();
    const runs = await page.evaluate(
      async (room) => globalThis.ocean.request({ op: 'runs', room }),
      room,
    );
    assert.equal(runs.ok, true);
    assert.ok(
      runs.data.some(
        (run) => binding.startsWith(run.runId + ' ') && run.turnStatus === 'uncertain',
      ),
    );
    const projection = await page.locator('#feedback').innerText();
    assert.doesNotMatch(projection, /Остановлено/);
    writeFileSync(
      join(f.root, 'explicit-cancel.json'),
      JSON.stringify({ cancelLabel, binding, runs, projection, env: f.env }, null, 2),
    );
    await page.screenshot({ path: join(f.root, 'explicit-cancel.png') });
    await gui.close();
    gui = undefined;
    await assert.rejects(f.stop(), (error) => {
      const result = JSON.parse(error.stdout).data;
      return (
        error.status === 4 && result.state === 'stop_incomplete' && result.outcome === 'uncertain'
      );
    });
    return f.root;
  } finally {
    await gui?.dispose();
    await f.close();
  }
}
