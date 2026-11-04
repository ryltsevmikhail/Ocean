import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { sshFetch, sshChildEnvironment } from './live-deepseek-transport.mjs';
const headers = { authorization: 'Bearer bridge-placeholder-only' };
const url = 'https://api.deepseek.com/chat/completions';
const body = '{"stream":true,"messages":[]}';
const fixture = (frames) => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-live-transport-'));
  let calls = 0;
  const fetch = sshFetch({
    root,
    remoteCode: '',
    launch() {
      calls++;
      return spawn(process.execPath, [
        '-e',
        'process.stdin.resume();process.stdin.on("end",()=>process.stdout.end(' +
          JSON.stringify(frames) +
          '));',
      ]);
    },
  });
  return {
    root,
    fetch,
    calls: () => calls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};
test('fixed route and dummy-only auth refuse before dispatch', async () => {
  const f = fixture('');
  try {
    await assert.rejects(f.fetch('https://other.invalid', { method: 'POST', headers, body }));
    await assert.rejects(
      f.fetch(url, { method: 'POST', headers: { authorization: 'Bearer secret-canary' }, body }),
    );
    const c = new globalThis.AbortController();
    c.abort();
    await assert.rejects(f.fetch(url, { method: 'POST', headers, body, signal: c.signal }));
    assert.equal(f.calls(), 0);
    assert.deepEqual(readdirSync(f.root), []);
  } finally {
    f.cleanup();
  }
});
test('genuine byte stream can be held through child exit without a false unknown', async () => {
  const bytes = 'data: {"content":"snow ☃"}\n\ndata: [DONE]\n\n';
  const frames =
    [
      { type: 'dispatching' },
      { type: 'headers', status: 200 },
      { type: 'data', base64: Buffer.from(bytes).toString('base64') },
      { type: 'done' },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n';
  const f = fixture(frames);
  try {
    writeFileSync(f.root + '/hold', '');
    const controller = new globalThis.AbortController();
    const r = await f.fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 100));
    rmSync(f.root + '/hold');
    assert.equal(await r.text(), bytes);
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    assert.equal(f.calls(), 1);
    const log = readFileSync(f.root + '/events.jsonl', 'utf8');
    assert.ok(!log.includes('unknown'));
    assert.ok(!log.includes('client_abort'));
  } finally {
    f.cleanup();
  }
});
test('truncated remote stream is unknown, preserves bytes and never retries', async () => {
  const f = fixture('{"type":"dispatching"}\n{"type":"headers","status":200}\n');
  try {
    const r = await f.fetch(url, { method: 'POST', headers, body });
    await assert.rejects(r.text(), /bridge_outcome_unknown/);
    assert.equal(f.calls(), 1);
    const log = readFileSync(f.root + '/events.jsonl', 'utf8');
    assert.ok(log.includes('unknown'));
    assert.ok(!log.includes('authorization'));
  } finally {
    f.cleanup();
  }
});

test('observer abort drains the existing remote request and never claims cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-live-abort-'));
  let calls = 0;
  const fetch = sshFetch({
    root,
    remoteCode: '',
    launch() {
      calls++;
      return spawn(process.execPath, [
        '-e',
        'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"headers",status:200})+"\\n");setTimeout(()=>process.stdout.end(JSON.stringify({type:"data",base64:"YWJj"})+"\\n"+JSON.stringify({type:"done"})+"\\n"),60);});',
      ]);
    },
  });
  try {
    const controller = new globalThis.AbortController();
    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    controller.abort();
    await assert.rejects(response.text(), { name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 150));
    const events = readFileSync(root + '/events.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(calls, 1);
    assert.ok(events.some((x) => x.state === 'client_abort_remote_not_cancelled'));
    assert.ok(events.some((x) => x.state === 'observed_complete'));
    assert.ok(events.some((x) => x.state === 'ssh_closed' && x.code === 0));
    assert.equal(readFileSync(root + '/' + events[0].id + '.response.sse', 'utf8'), 'abc');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonprivate evidence directory refuses before any request bytes are stored', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-live-custody-'));
  try {
    chmodSync(root, 0o755);
    assert.throws(
      () =>
        sshFetch({
          root,
          remoteCode: '',
          launch() {
            assert.fail('must not launch');
          },
        }),
      /private canonical/,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual child retains private HOME/XDG paths but no provider or agent credential', () => {
  const keys = [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'TMPDIR',
  ];
  const source = Object.fromEntries(keys.map((key) => [key, '/private-fixture/' + key]));
  source.DEEPSEEK_API_KEY = 'secret-canary';
  source.SSH_AUTH_SOCK = '/forbidden-agent';
  const code = `const assert=require('node:assert/strict'); for(const key of ${JSON.stringify(keys)}) assert.equal(process.env[key], '/private-fixture/'+key); assert.equal(process.env.DEEPSEEK_API_KEY,undefined);assert.equal(process.env.SSH_AUTH_SOCK,undefined);process.stdout.write('verified');`;
  const child = spawnSync(process.execPath, ['-e', code], {
    env: sshChildEnvironment(source),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'verified');
  assert.equal(child.stderr, '');
  assert.throws(() => sshChildEnvironment({ PATH: '/bin' }), /explicit private environment/);
});
