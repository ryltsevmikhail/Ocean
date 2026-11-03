import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from './profile.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';
import { child, profileCli } from '../../test-fixtures/profile-cli.test.js';
const clean: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
async function fixture(extraBots = 0) {
  const root = mkdtempSync(join(tmpdir(), 'ocean-cli-')),
    run = join(root, 'r'),
    profile = join(root, 'p');
  clean.push(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const r = openOceanProfile(profile, true);
  await r.ready;
  const facts = rooms(r.conversations);
  for (let i = 0; i < extraBots; i++) {
    const id = 'page' + i;
    const row = r.conversations.execute({
      type: 'CreateBot',
      workspaceId: facts.workspaceId,
      requestId: id,
      handle: id,
      name: id,
      role: i < 55 ? 'x' + '\u0001'.repeat(8000) : 'role',
      provider: 'test',
      model: 'test',
    });
    if (!row.ok) throw Error('fixture bot');
  }
  r.close();
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const host = await startLocalRuntime({
    profile,
    provider: gatedProvider(
      () => gate,
      () => calls++,
    ),
  });
  clean.push(async () => {
    release();
    await host.stop();
  });
  return {
    ...facts,
    root,
    run,
    profile,
    host,
    release,
    calls: () => calls,
    cli: profileCli(profile, run),
  };
}
it('routes conversation mutations, reads and durable admissions through a listening owner', async () => {
  const f = await fixture(),
    cli = f.cli;
  const add = [
    'bot',
    'add',
    '--handle',
    'new',
    '--name',
    'New',
    '--role',
    'My job',
    '--request-id',
    'new-bot',
  ];
  const bot = await cli(...add);
  expect(bot).toMatchObject({
    code: 0,
    reply: { version: 1, data: { kind: 'bot', data: { role: 'My job' } } },
  });
  expect(await cli(...add)).toEqual(bot);
  const conflict = [...add];
  conflict[7] = 'changed';
  expect((await cli(...conflict)).reply.error.code).toBe('request_conflict');
  expect((await cli('bot', 'list')).reply.data).toHaveLength(3);
  expect((await cli('room', 'direct', '--bot', 'new')).reply.data.data.kind).toBe('direct');
  const group = (await cli('room', 'group', '--name', 'Team', '--bot', 'new', '--bot', 'dev')).reply
    .data.data.id;
  expect((await cli('room', 'list')).reply.data).toHaveLength(4);
  expect((await cli('room', 'members', group)).reply.data).toEqual(
    expect.arrayContaining([bot.reply.data.data]),
  );
  expect(
    (await cli('room', 'list')).reply.data.find((r: { id: string }) => r.id === group),
  ).toMatchObject({ botIds: expect.arrayContaining([bot.reply.data.data.id]) });
  const post = await cli('send', group, '--text', 'group', '--request-id', 'post');
  expect(post.reply.data).toMatchObject({ requestId: 'post', runId: null, status: 'recorded' });
  expect((await cli('history', group)).reply.data).toMatchObject([
    { body: 'group', id: post.reply.data.messageId },
  ]);
  const args = ['send', f.roomId, '--text', 'hello', '--request-id', 'once'];
  const first = await cli(...args);
  expect(first.reply.data).toMatchObject({
    requestId: 'once',
    status: 'admitted',
    runId: expect.any(String),
  });
  expect(await cli(...args)).toEqual(first);
  const id = first.reply.data.runId;
  expect((await cli('run', 'list')).reply.data).toMatchObject([{ runId: id }]);
  expect((await cli('run', 'show', id)).reply.data.runId).toBe(id);
  expect((await cli('run', 'review', id)).reply.data).toMatchObject({
    runId: id,
    version: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect((await cli('run', 'show', id, '--room', group)).reply.error.code).toBe('unknown_run');
  f.release();
  expect(f.calls()).toBe(1);
}, 20000);
it('refuses maintenance before touching arguments and separates static diagnostics', async () => {
  const { cli, root } = await fixture(),
    missing = join(root, 'unread'),
    dest = join(root, 'archive');
  for (const args of [
    ['init', '--workspace', missing],
    ['project', 'add', '--config', missing],
    ['coding', 'start'],
    ['coding', 'review'],
    ['coding', 'apply'],
    ['coding', 'reconcile-apply'],
    ['backup', '--to', dest],
    ['restore', '--from', missing],
    ['doctor'],
  ]) {
    expect(await cli(...args), args.join(' ')).toMatchObject({
      code: 3,
      reply: { error: { code: 'maintenance_required' } },
    });
  }
  expect(await cli('doctor', '--static')).toMatchObject({
    code: 0,
    reply: { data: { database: { status: 'not_inspected' } } },
  });
  expect(existsSync(dest)).toBe(false);
});
it('never opens the profile on ambiguous endpoint, version or authentication failure', async () => {
  const f = await fixture(),
    p = localRuntimePaths(f.profile),
    original = readFileSync(p.descriptor, 'utf8'),
    desc = JSON.parse(original),
    db = join(f.profile, 'runtime.sqlite');
  const before = readFileSync(db);
  try {
    for (const [bytes, expected] of [
      ['{', 'invalid_descriptor'],
      [JSON.stringify({ ...desc, protocol: 2 }), 'invalid_descriptor'],
      [JSON.stringify({ ...desc, capability: '0'.repeat(64) }), 'authentication_failed'],
    ]) {
      writeFileSync(p.descriptor, bytes!);
      expect((await f.cli('backup', '--to', join(f.root, 'copy'))).reply.error.code).toBe(expected);
      expect((await f.cli('bot', 'list')).reply.error.code).toBe(expected);
      expect(readFileSync(db)).toEqual(before);
      expect(existsSync(join(f.root, 'copy'))).toBe(false);
    }
  } finally {
    writeFileSync(p.descriptor, original);
  }
});
it('requires private paths and an existing profile before using any published descriptor', async () => {
  const f = await fixture(),
    p = localRuntimePaths(f.profile);
  chmodSync(p.descriptor, 0o644);
  try {
    expect((await f.cli('bot', 'list')).reply.error.code).toBe('insecure_permissions');
  } finally {
    chmodSync(p.descriptor, 0o600);
  }
  const moved = join(f.root, 'moved');
  renameSync(f.profile, moved);
  try {
    expect((await f.cli('bot', 'list')).reply.error?.code).toBe('profile_missing');
  } finally {
    renameSync(moved, f.profile);
  }
});
it('reports ACP owner_busy without competing for the live endpoint', async () => {
  const f = await fixture(),
    p = child(['acp'], { RUNNE_DB: join(f.profile, 'runtime.sqlite') });
  p.proc.stdin.end();
  expect(await p.exit).toBe(3);
  expect(p.out()).toBe('');
  expect(p.err().trim()).toBe('owner_busy');
  const separate = child(['acp'], { RUNNE_DB: join(f.root, 'separate.sqlite') });
  separate.proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + '\n',
  );
  await vi.waitFor(() => expect(separate.out()).toContain('"protocolVersion":1'));
  expect(separate.out()).not.toContain('turns.submit');
  const rpc = (id: number, method: string, params: unknown) =>
    separate.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  try {
    rpc(2, 'session/new', { cwd: f.root });
    await vi.waitFor(() => expect(separate.out()).toContain('"sessionId":"s_0001"'));
    rpc(3, 'session/prompt', {
      sessionId: 's_0001',
      prompt: [{ type: 'text', text: 'fixture prompt' }],
    });
    await vi.waitFor(() => expect(separate.out()).toContain('"stopReason":"end_turn"'));
    expect(separate.out()).toContain('"method":"session/update"');
    rpc(4, 'session/cancel', { sessionId: 's_0001' });
    await vi.waitFor(() => expect(separate.out()).toContain('"id":4'));
  } finally {
    separate.proc.stdin.end();
    expect(await separate.exit).toBe(0);
  }
});

it('reads every bot across count- and frame-limited pages', async () => {
  const f = await fixture(205);
  const { reply } = await f.cli('bot', 'list');
  expect(reply.data).toHaveLength(207);
  expect(new Set(reply.data.map((r: { id: string }) => r.id)).size).toBe(207);
});
