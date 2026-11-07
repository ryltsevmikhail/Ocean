import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
test('synthetic HTTP vision/hold/abort and committed receipt drop have no network fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'oa-handoff-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, OCEAN_NATIVE_REQUESTS: join(root, 'requests.jsonl') },
      input: `
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { Buffer } from 'node:buffer';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
await import('./apps/desktop/qa/model-handoff-transport.mjs');
const root = ${JSON.stringify(root)};
await assert.rejects(globalThis.fetch('https://unexpected.invalid'), /unexpected synthetic/);
const url = 'https://api.deepseek.com/chat/completions';
const options = (text) => ({method:'POST', body:JSON.stringify({model:'deepseek-flash', messages:[{role:'user',content:text}]})});
const normal = await globalThis.fetch(url, options('normal'));
assert.match(await normal.text(), /Synthetic handoff: normal/);
const vision = await globalThis.fetch(url, options([{type:'text',text:'vision'},{type:'image_url', image_url:{url:'data:image/png;base64,YQ=='}}]));
assert.match(await vision.text(), /Synthetic handoff: vision/);
const abort = new AbortController();
const pending = globalThis.fetch(url, {...options('held-abort'),signal:abort.signal});
abort.abort();
await assert.rejects(pending, /abort/i);
const held = globalThis.fetch(url, options('held-release'));
writeFileSync(join(root,'release-held-release'),'');
assert.match(await (await held).text(), /held-release/);
const server = createServer(socket=>socket.on('data',()=>socket.write(Buffer.from(JSON.stringify({id:'wire', result:{messageId:'m1',runId:'r1',requestId:'q1'}})+'\\n'))));
await new Promise(resolve=>server.listen(join(root,'socket'),resolve));
writeFileSync(join(root,'drop-chat'),'');
const socket = connect(join(root,'socket'));
await new Promise(resolve=>socket.once('connect',resolve));
let received=''; socket.on('data',b=>received+=b);
const closed=new Promise(resolve=>socket.once('close',resolve));
socket.write(JSON.stringify({id:'wire',method:'turns.submit',params:{requestId:'q1'}})+'\\n'); await closed;
assert.equal(received,'');
assert.deepEqual(JSON.parse(readFileSync(join(root,'dropped.jsonl'),'utf8')), {messageId:'m1',runId:'r1',requestId:'q1'});
await new Promise(resolve=>server.close(resolve));
`,
    });
    assert.equal(result.status, 0, result.stderr + String(result.error ?? ''));
    const providers = readFileSync(join(root, 'provider.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(providers.length, 4);
    assert.equal(providers[1].images.length, 1);
    assert.equal(
      providers.every((p) => p.synthetic === true),
      true,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
