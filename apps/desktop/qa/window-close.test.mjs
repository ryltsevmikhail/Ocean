import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { closePage } from './window-close.mjs';

for (const [reason, evaluate] of [
  ['rejected', () => Promise.reject(Error('evaluation failed'))],
  ['stalled', () => new Promise(() => {})],
]) {
  test('a missing page close reaches teardown after a ' + reason + ' evaluation', async () => {
    const page = Object.assign(new EventEmitter(), { evaluate });
    // Independent watchdog distinguishes a driver that hangs from its own close diagnostic.
    const closing = closePage(page, 20);
    await assert.rejects(
      Promise.race([closing, setTimeout(300).then(() => Promise.reject(Error('watchdog')))]),
      /Desktop page close timed out/,
    );
    assert.equal(page.listenerCount('close'), 0);
  });
}
