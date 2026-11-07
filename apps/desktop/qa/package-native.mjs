import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { wait } from './current-window.mjs';

// Inspect only the loopback inspector published by this packaged process.
export async function inspectPackage(
  log,
  expression,
  timeoutMs = 10000,
  { signal, step = (issue) => issue() } = {},
) {
  const issue = (action) => {
    signal?.throwIfAborted();
    return step(action);
  };
  let address;
  await wait(
    () =>
      issue(
        () => (address = log().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]),
      ),
    timeoutMs,
  );
  const ws = issue(() => new globalThis.WebSocket(address));
  let timer, onAbort, onOpen;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => reject(Error('main inspector timed out')), timeoutMs);
      ws.addEventListener('error', () => reject(Error('main inspector failed')));
      ws.addEventListener('close', () => reject(Error('main inspector closed')));
      ws.addEventListener('message', ({ data }) => {
        try {
          const result = JSON.parse(data);
          if (result.id !== 1) return;
          if (result.error || result.result.exceptionDetails) throw Error(JSON.stringify(result));
          resolve(result.result.result.value);
        } catch (error) {
          reject(error);
        }
      });
      onOpen = () => {
        try {
          issue(() =>
            ws.send(
              JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                  expression: `(() => { const e = process.getBuiltinModule('module').createRequire('/ocean-inspector.cjs')('electron'); const win=e.BrowserWindow.getAllWindows()[0]; return (${expression}); })()`,
                  returnByValue: true,
                },
              }),
            ),
          );
        } catch (error) {
          reject(error);
        }
      };
      ws.addEventListener('open', onOpen, { once: true });
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (onOpen) ws.removeEventListener('open', onOpen);
    ws.close();
  }
}
export async function packageNative(f, log) {
  const proof = await inspectPackage(
    log,
    "({userData:e.app.getPath('userData'),versions:process.versions,webPreferences:win.webContents.getLastWebPreferences()})",
    undefined,
    { signal: f.signal, step: f.inspectorStep },
  );
  assert.ok(proof.webPreferences);
  writeFileSync(join(f.root, 'native.jsonl'), JSON.stringify(proof) + '\n', { mode: 0o600 });
}
