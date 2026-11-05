import { InvocationSend } from './send.js';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, readlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { client, empty, immutable } from './prototype-types.js';

const [role, mode, canary, socket] = process.argv.slice(2);
function record(name: string, data: unknown) {
  writeFileSync(name + '.tmp', JSON.stringify(data), { flush: true });
  renameSync(name + '.tmp', name + '.json');
}
const identity = () => ({
  pid: process.pid,
  start: readFileSync('/proc/self/stat', 'utf8').split(' ')[21],
});
async function server() {
  const s = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } });
  s.setRequestHandler('tools/list', () => ({
    tools: [{ name: 'write', inputSchema: { type: 'object' } }],
  }));
  s.setRequestHandler('tools/call', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
    record('effect', {
      server: identity(),
      child: child.pid,
      stdout: readlinkSync('/proc/self/fd/1'),
      childStdout: readlinkSync('/proc/' + child.pid + '/fd/1'),
    });

    if (mode === 'abort' || mode === 'parent-failure') await delay(20000);
    if (mode === 'overflow') {
      process.stdout.write('z'.repeat(32768));
      await delay(300);
    }
    process.stderr.write('e'.repeat(32768));
    return { content: [{ type: 'text', text: 'done' }] };
  });
  const socketAccessible = await new Promise<boolean>((resolve) => {
    const probe = connect(socket!);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  record('env', {
    home: process.env['HOME'],
    cwd: process.cwd(),
    pwd: process.env['PWD'],
    custom: process.env['FIXTURE_CUSTOM'] ?? null,
    keys: Object.keys(process.env).sort(),
    canaryVisible: existsSync(canary!),
    socketAccessible,
  });
  await s.connect(new StdioServerTransport());
}
async function caller() {
  const r = empty('stdio-' + mode);
  const c = client(false);
  const ac = new AbortController();
  let current = true;
  let notify = () => {};
  let release = () => {};
  const entered = new Promise<void>((r) => {
    notify = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let drained = () => {};
  const writerDone = new Promise<void>((r) => {
    drained = r;
  });
  if (mode === 'revoked')
    void entered.then(() => {
      current = false;
      release();
    });
  let overflowDetected = false;
  c.onerror = (e) => {
    if (e.message.includes('ReadBuffer exceeded maximum size of 8192')) {
      overflowDetected = true;
      ac.abort();
    }
  };
  let stderrBytes = 0;
  let retained = Buffer.alloc(0);
  let sdkPid: number | null = null;
  const save = () =>
    record('caller', {
      ...r,
      client: identity(),
      sdkPid,
      stderrBytes,
      overflowDetected,
      retainedBytes: retained.length,
    });
  class Measured extends StdioClientTransport {
    override async send(message: Parameters<StdioClientTransport['send']>[0]) {
      const held =
        mode === 'held-timeout' && 'method' in message && message.method === 'tools/call';
      try {
        if (!('method' in message) || message.method !== 'tools/call') r.metadataAttempts++;
        else {
          r.sdkAttempts++;
          if (mode === 'revoked' || mode === 'held-timeout') {
            notify();
            await gate;
          }
          if (!current) throw Error('no current authority');
          InvocationSend.current().admit(() => {
            r.businessAttempts++;
            // Synchronous evidence and the public writer invocation are adjacent.
            r.outcome = 'uncertain';
            save();
          });
        }
        const sending = super.send(message);
        if ('method' in message && message.method === 'tools/call' && mode === 'custom')
          current = false;
        return await sending;
      } finally {
        if (held) drained();
      }
    }
  }
  const transport = new Measured({
    // The managed outer unit owns the entire tree. Give the server its own
    // PID namespace and workspace; no access to the client's dispatch record.
    command: '/usr/bin/bwrap',
    args: [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/home/worker',
      '--bind',
      '/workspace/server',
      '/workspace',
      '--ro-bind',
      '/workspace/fixture.cjs',
      '/fixture.cjs',
      '--ro-bind',
      '/toolchain/node',
      '/toolchain/node',
      '--chdir',
      '/workspace',
      '/toolchain/node',
      '/fixture.cjs',
      'server',
      mode!,
      canary!,
      socket!,
    ],
    cwd: '/workspace',
    stderr: 'pipe',
    maxBufferSize: 8192,
    ...(mode === 'default' ? {} : { env: { FIXTURE_CUSTOM: 'synthetic' } }),
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    retained = Buffer.concat([retained, chunk.subarray(0, Math.max(0, 512 - retained.length))]);
  });
  try {
    await c.connect(transport, { timeout: 4000 });
    sdkPid = transport.pid;
    const tool = (await c.listTools(undefined, { timeout: 4000 })).tools[0];
    if (!tool) throw Error('missing tool');
    if (mode === 'abort' || mode === 'parent-failure')
      void (async () => {
        while (!ac.signal.aborted && !existsSync('server/effect.json')) await delay(2);
        if (mode === 'parent-failure') process.kill(process.pid, 'SIGKILL');
        ac.abort();
      })();
    const timeout = mode === 'held-timeout' ? 200 : 5000;
    const invocation = new InvocationSend(timeout, ac.signal);
    try {
      const result = await invocation.run(() =>
        c.callTool(
          { name: 'write', arguments: {} },
          { toolDefinition: immutable(tool), timeout, signal: ac.signal },
        ),
      );
      if (!result.isError) r.outcome = 'observed';
    } catch {
      r.outcome = invocation.sent ? 'uncertain' : 'not_started';
    }
    if (mode === 'held-timeout') {
      if (r.sdkAttempts !== 1 || r.outcome !== 'not_started')
        throw Error('expected one held writer at settlement');
      release();
      await writerDone;
      await c.ping({ timeout: 2000 });
    }
    save();
  } finally {
    ac.abort();
    await c.close();
    save();
  }
}
if (role === 'server') void server();
else if (role === 'caller') void caller().then(() => process.exit(0));
