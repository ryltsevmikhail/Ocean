import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './current-window.mjs';

// Packaged Electron ignores NODE_OPTIONS imports. Inspect its actual native API
// over an explicitly enabled loopback-only main inspector, without changing app bytes.
export async function packageNative(f, log) {
  let address;
  await wait(() => {
    address = log().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
    return address;
  });
  const ws = new globalThis.WebSocket(address);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  try {
    const response = new Promise((resolve, reject) => {
      ws.addEventListener('message', ({ data }) => {
        const result = JSON.parse(data);
        if (result.id !== 1) return;
        if (result.error || result.result.exceptionDetails) reject(Error(JSON.stringify(result)));
        else resolve(result.result.result.value);
      });
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `JSON.stringify((() => { const e = process.getBuiltinModule('module').createRequire('/ocean-inspector.cjs')('electron'); return {userData:e.app.getPath('userData'),versions:process.versions,webPreferences:e.BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}; })())`,
          returnByValue: true,
        },
      }),
    );
    const proof = JSON.parse(await response);
    assert.ok(proof.webPreferences);
    writeFileSync(join(f.root, 'native.jsonl'), JSON.stringify(proof) + '\n', { mode: 0o600 });
  } finally {
    ws.close();
  }
}
