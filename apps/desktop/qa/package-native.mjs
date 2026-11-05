import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { wait } from './current-window.mjs';

// Inspect only the loopback inspector published by this packaged process.
export async function inspectPackage(log, expression, timeoutMs = 10000) {
  let address;
  await wait(
    () => (address = log().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]),
    timeoutMs,
  );
  const ws = new globalThis.WebSocket(address);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
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
      ws.addEventListener('open', () =>
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
    });
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}
export async function packageNative(f, log) {
  const proof = await inspectPackage(
    log,
    "({userData:e.app.getPath('userData'),versions:process.versions,webPreferences:win.webContents.getLastWebPreferences()})",
  );
  assert.ok(proof.webPreferences);
  writeFileSync(join(f.root, 'native.jsonl'), JSON.stringify(proof) + '\n', { mode: 0o600 });
}
