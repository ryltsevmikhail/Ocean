import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeCase } from './model-native-case.mjs';
import { inspectPackage } from './package-native.mjs';

test('a late inspector open closes the socket without sending a resize after case expiry', async (t) => {
  const control = createNativeCase(),
    created = Promise.withResolvers(),
    trace = [];
  let queuedOpen, closedBeforeOpen;
  class Socket extends globalThis.EventTarget {
    constructor() {
      super();
      trace.push('created');
      created.resolve(this);
    }
    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
      if (type === 'open') queuedOpen = listener;
    }
    send() {
      trace.push('sent');
    }
    close() {
      trace.push('closed');
    }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  const run = control.run(
    (step) =>
      inspectPackage(
        () => 'Debugger listening on ws://127.0.0.1:1234/id',
        'win.setBounds({width:1024,height:800})',
        200,
        { signal: control.signal, step },
      ),
    30,
    async () => {
      trace.push('retiring');
      await created.promise;
      await delay(0);
      closedBeforeOpen = trace.includes('closed');
      queuedOpen(); // An already queued handshake callback may outlive socket retirement.
    },
  );
  await assert.rejects(run, /timed out/);
  assert.deepEqual(
    trace.filter((event) => event === 'sent'),
    [],
  );
  assert.equal(closedBeforeOpen, true);
});
