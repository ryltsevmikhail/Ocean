/* eslint-disable no-undef -- page.evaluate callbacks run in the renderer, not in Node. */
// Drives one real Electron page through the composer reachability regression at a given width.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable, fileSHA256, measureLayout } from './layout-measure.mjs';

export function createLayoutDriver({ page, root, evidence, height = 800 }) {
  const requestCount = () => {
    try {
      return readFileSync(join(root, 'requests'), 'utf8').trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const field = () => page.getByLabel('Сообщение', { exact: true });
  async function screenshot(name) {
    const path = join(root, name + '.png');
    await page.screenshot({ path });
    evidence.screenshots.push({
      name,
      file: path,
      bytes: readFileSync(path).length,
      sha256: fileSHA256(path),
    });
  }
  async function resize(width) {
    try {
      await page.setViewportSize({ width, height });
    } catch {
      const session = await page.context().newCDPSession(page);
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    await page.waitForFunction((expected) => innerWidth === expected, width);
  }
  async function setDetails(open) {
    const toggle = page.getByRole('button', { name: 'Сведения', exact: true });
    if (((await toggle.getAttribute('aria-expanded')) === 'true') !== open) await toggle.click();
    await page.waitForFunction(
      (expected) => !!document.querySelector('.shell > aside.details') === expected,
      open,
    );
  }
  async function measure(width, screen, draft = '') {
    const result = await measureLayout(page);
    const detailsOpen = screen.startsWith('details-open');
    evidence.measurements.push({
      width,
      screen,
      draft,
      viewport: result.viewport,
      columns: result.columns,
      rects: result.rects,
      details: result.details,
      controls: result.controls,
      hits: result.hits,
      overlaps: result.overlaps,
      history: result.history,
    });
    const problems = checkReachable(result, width, { detailsOpen, draft });
    if (problems.length) {
      evidence.failure = { width, screen, problems, measurement: result };
      throw Error(
        'composer obstructed at ' + width + 'px (' + screen + '): ' + JSON.stringify(problems),
      );
    }
    return result;
  }
  async function chooseRecipient(handle) {
    const recipient = page.getByLabel('Кому');
    if (await recipient.count()) await recipient.selectOption(handle);
  }
  async function waitAnswer(text) {
    await page
      .locator('#history')
      .getByText('Test provider · ' + text, { exact: true })
      .waitFor();
  }
  async function sent(text, before) {
    await waitAnswer(text);
    assert.equal(requestCount(), before + 1, 'exactly one provider request for ' + text);
    await page.waitForFunction(() => document.activeElement?.id === 'draft');
    assert.equal(await field().inputValue(), '', 'draft cleared and focus restored after send');
  }
  async function sendByClick(width, text) {
    const before = requestCount();
    await chooseRecipient('dev');
    await field().fill(text);
    await measure(width, 'details-open', text);
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await sent(text, before);
  }
  async function sendByEnter(width, detailsOpen, text) {
    const before = requestCount();
    await chooseRecipient('dev');
    await field().fill(text);
    await measure(width, detailsOpen ? 'details-open' : 'details-closed', text);
    await field().press('Enter');
    await sent(text, before);
  }
  return { requestCount, screenshot, resize, setDetails, measure, sendByClick, sendByEnter };
}
