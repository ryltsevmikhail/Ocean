// Run with the private environment runner and a fresh owned proof directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import fsPromises from 'node:fs/promises';
import { mock } from 'node:test';
import type { ServiceJson } from '@runnets/domain';
import { syncBuiltinESMExports } from 'node:module';
import { createMcpServiceTransport } from '@runnets/integrations-mcp';
import { admission, connection } from './admission.ts';
const [dir, mode] = process.argv.slice(2);
assert.ok(dir && mode);
const run = join(dir, mode),
  profile = join(run, 'profile'),
  workspace = join(run, 'workspace');
mkdirSync(run);
mkdirSync(profile);
mkdirSync(workspace);
const file = join(dir, mode === 'ready' ? 'official/filesystem.mjs' : 'fault.mjs');
const cfg = connection({
  kind: 'stdio',
  executable: file,
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  args: ['/workspace'],
  ...(mode === 'ready'
    ? {
        packageJsonSha256: createHash('sha256')
          .update(readFileSync(join(dir, 'official/package.json')))
          .digest('hex'),
      }
    : {}),
});
const canary = join(profile, 'canary'),
  socket = join(process.env['TMPDIR']!, 'owner.sock');
writeFileSync(canary, 'private-canary');
const sock = createServer((s) => s.destroy());
sock.listen(socket);
await once(sock, 'listening');
writeFileSync(join(workspace, 'fixture.json'), JSON.stringify({ mode, canary, socket }));
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
const enter = gate(),
  resume = gate();
let attempts = 0;
const options = {
  protocol: 'legacy' as const,
  stdio: { profileRoot: profile, workspaces: { connection: workspace } },
  prepareDispatch: async () => {
    attempts++;
    enter.resolve();
    if (['revoke', 'deadline', 'cancel'].includes(mode)) await resume.promise;
  },
};
const t = createMcpServiceTransport(options);
const dispatches = join(run, 'dispatches');
const a = admission(
  join(profile, 'db'),
  cfg,
  {
    invoke: (input) =>
      t.invoke({
        ...input,
        authorizeDispatch() {
          if (!input.authorizeDispatch()) return false;
          appendFileSync(dispatches, 'send\n', { flush: true });
          return true;
        },
      }),
  },
  mode === 'deadline' ? 200 : 6000,
);
const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/' + process.getuid!() };
const ctl = (...args: string[]) =>
  execFileSync('/usr/bin/systemctl', ['--user', ...args], { env, encoding: 'utf8' }).trim();
const read = (p: string) => readFileSync(p, 'utf8').trim();
const inspect = (cg: string) => {
  const root = '/sys/fs/cgroup' + cg;
  const pids = read(root + '/cgroup.procs')
    .split('\n')
    .map(Number);
  return {
    cg,
    pids: pids.map((pid) => ({
      pid,
      start: read('/proc/' + pid + '/stat')
        .split(') ')
        .at(-1)!
        .split(' ')[19],
    })),
    fields: Object.fromEntries(
      [
        'cgroup.events',
        'pids.current',
        'pids.peak',
        'memory.current',
        'memory.peak',
        'memory.max',
        'pids.max',
        'pids.events',
      ].map((k) => [k, read(root + '/' + k)]),
    ),
  };
};
const evidence: Record<string, unknown> = { mode };
let cleanup, cg: string | undefined;
try {
  const candidate = await t.discover(cfg, {
    signal: new AbortController().signal,
    deadlineMs: 12000,
    authorizeMetadata: () => a.metadata(cfg),
  });
  const s = { ...candidate, id: 'snapshot' };
  assert.ok(a.publish(s) && t.activate(candidate, s, () => a.current(s)));
  const unitPrefix =
    'ocean-mcp-' +
    createHash('sha256')
      .update(JSON.stringify([profile, cfg.id]))
      .digest('hex')
      .slice(0, 32) +
    '-';
  const unit = ctl('list-units', '--all', '--plain', '--no-legend', unitPrefix + '*.service').split(
    /\s+/,
  )[0];
  assert.ok(unit && unit.startsWith(unitPrefix));
  cg = ctl('show', unit, '--property=ControlGroup', '--value');
  const before = inspect(cg);
  evidence['before'] = before;
  evidence['protocol'] = s.provenance['protocol'];
  evidence['toolCount'] = s.tools.length;
  assert.equal(before.fields['memory.max'], '536870912');
  assert.equal(before.fields['pids.max'], '64');
  a.grant(
    mode === 'ready' ? ['list_allowed_directories', 'write_file', 'read_text_file'] : ['write'],
  );
  const call = (tool: string, args: ServiceJson, id: string, signal?: AbortSignal) =>
    a.call(s.id, tool, args, id, signal);
  if (mode === 'ready') {
    assert.equal((await call('list_allowed_directories', {}, 'allowed')).outcome?.code, 'ok');
    assert.equal(
      (await call('write_file', { path: '/workspace/note', content: 'ready-proof' }, 'write'))
        .outcome?.code,
      'ok',
    );
    assert.equal(read(join(workspace, 'note')), 'ready-proof');
    const reply = (await call('read_text_file', { path: '/workspace/note' }, 'read')).outcome;
    assert.equal(reply?.code, 'ok');
    assert.ok(JSON.stringify(reply.result).includes('ready-proof'));
    assert.equal(
      (await call('read_text_file', { path: canary }, 'escape')).outcome?.code,
      'vendor_error',
    );
    assert.equal(
      (await call('write_file', { path: canary, content: 'escape' }, 'write-escape')).outcome?.code,
      'vendor_error',
    );
    assert.equal(read(canary), 'private-canary');
    evidence['outcomes'] = [
      'allowed',
      'write',
      'read',
      'escape-read-denied',
      'escape-write-denied',
    ];
  } else {
    const obs = JSON.parse(read(join(workspace, 'observed.json'))) as {
      cwd: string;
      env: Record<string, string>;
      canary: boolean;
      socket: boolean;
    };
    assert.equal(obs.cwd, '/workspace');
    assert.equal(obs.env['PWD'], '/workspace');
    assert.equal(obs.env['HOME'], '/home/worker');
    assert.equal(obs.canary, false);
    assert.equal(obs.socket, false);
    assert.deepEqual(
      Object.keys(obs.env).sort(),
      [
        'HOME',
        'LANG',
        'PATH',
        'PWD',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_RUNTIME_DIR',
        'XDG_STATE_HOME',
      ].sort(),
    );
    evidence['server'] = obs;
    const ac = new AbortController();
    const promise = call('write', {}, 'invoke', ac.signal);
    await enter.promise;
    if (mode === 'revoke') a.owner.revoke({ grantId: 'grant', revision: 1 });
    if (mode === 'cancel') ac.abort();
    if (mode !== 'deadline') resume.resolve();
    const withheld = ['revoke', 'deadline', 'cancel'].includes(mode);
    if (mode === 'kill' || mode === 'abort') {
      for (let i = 0; !existsSync(join(workspace, 'descendant.json')) && i < 200; i++)
        await delay(10);
      assert.ok(existsSync(join(workspace, 'descendant.json')));
      evidence['during'] = inspect(cg);
      if (mode === 'kill') {
        writeFileSync(join(run, 'before-kill.json'), JSON.stringify(evidence));
        while (!existsSync(join(run, 'kill-now'))) await delay(20);
        process.kill(process.pid, 'SIGKILL');
      }
      ac.abort();
    }
    const r = await promise;
    resume.resolve();
    await delay(25);
    assert.equal(
      r.outcome?.kind,
      withheld ? 'not_started' : ['limit', 'observer'].includes(mode) ? 'observed' : 'uncertain',
    );
    assert.equal(attempts, 1);
    const records = existsSync(join(workspace, 'effects'))
      ? readFileSync(join(workspace, 'effects'), 'utf8')
      : '';
    assert.equal(records, withheld ? '' : 'effect\n');
    assert.equal(
      existsSync(dispatches) ? readFileSync(dispatches, 'utf8') : '',
      withheld ? '' : 'send\n',
    );
    if (!withheld) {
      const child = JSON.parse(read(join(workspace, 'descendant.json'))) as {
        stdout: string;
        childStdout: string;
      };
      assert.equal(child.stdout, child.childStdout);
      evidence['child'] = child;
    }
    if (mode === 'limit') {
      const limit = JSON.parse(read(join(workspace, 'pids-limit.json'))) as { status: string };
      evidence['pidsLimit'] = limit;
      assert.equal(limit.status, 'EAGAIN');
      evidence['during'] = inspect(cg);
    }
    evidence['outcome'] = r.outcome?.kind;
    evidence['effects'] = Number(!withheld);
  }
  evidence['attempts'] = attempts;
} finally {
  resume.resolve();
  const original = fsPromises.readFile;
  if (mode === 'observer') {
    mock.method(
      fsPromises,
      'readFile',
      (path: Parameters<typeof original>[0], ...rest: [Parameters<typeof original>[1]?]) =>
        String(path) === '/sys/fs/cgroup' + cg + '/cgroup.events'
          ? Promise.reject(Object.assign(Error('lost observation'), { code: 'EACCES' }))
          : original(path, ...rest),
    );
    syncBuiltinESMExports();
  }
  try {
    cleanup = await t.close();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    a.store.close();
    sock.close();
  }
  evidence['cleanup'] = cleanup;
  if (cg)
    evidence['retired'] =
      !readdirSync('/sys/fs/cgroup' + cg.slice(0, cg.lastIndexOf('/'))).includes(
        cg.split('/').at(-1)!,
      ) || read('/sys/fs/cgroup' + cg + '/cgroup.events').includes('populated 0');
  writeFileSync(join(run, 'result.json'), JSON.stringify(evidence, null, 2));
}
assert.equal(cleanup.status, mode === 'observer' ? 'unknown' : 'confirmed');
assert.ok(evidence['retired']);
console.log(mode, 'ok', attempts);
