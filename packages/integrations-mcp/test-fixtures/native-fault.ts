// Synthetic SDK server only. The owner uses exactly the public production transport.
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, readlinkSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
const config = JSON.parse(readFileSync('/workspace/fixture.json', 'utf8')) as {
  mode: string;
  canary: string;
  socket: string;
};
const probe = await new Promise((resolve) => {
  const s = connect(config.socket);
  s.once('error', () => resolve(false));
  s.once('connect', () => {
    s.destroy();
    resolve(true);
  });
});
const stat = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1)!.split(' ');
writeFileSync(
  '/workspace/observed.json',
  JSON.stringify({
    pid: process.pid,
    start: stat[19],
    cwd: process.cwd(),
    env: process.env,
    canary: existsSync(config.canary),
    socket: probe,
  }),
);
const server = new Server({ name: 'fault', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', () => ({
  tools: [{ name: 'write', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler('tools/call', async () => {
  appendFileSync('/workspace/effects', 'effect\n', { flush: true });
  const child = spawn('/usr/bin/sleep', ['45'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  child.unref();
  writeFileSync(
    '/workspace/descendant.json',
    JSON.stringify({
      pid: child.pid,
      stdout: readlinkSync('/proc/self/fd/1'),
      childStdout: readlinkSync('/proc/' + child.pid + '/fd/1'),
    }),
  );
  if (config.mode === 'drop') process.exit(23);
  if (config.mode === 'overflow') {
    process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
    await new Promise(() => {});
  }
  if (config.mode === 'abort' || config.mode === 'kill') await new Promise(() => {});
  if (config.mode === 'limit') {
    let count = 1;
    for (let i = 0; i < 100; i++) {
      const proc = spawn('/usr/bin/sleep', ['45'], { stdio: 'ignore' });
      const status = await new Promise((resolve) => {
        proc.once('spawn', () => resolve('ok'));
        proc.once('error', (e) => resolve((e as NodeJS.ErrnoException).code));
      });
      if (status !== 'ok') {
        writeFileSync('/workspace/pids-limit.json', JSON.stringify({ count, status }));
        break;
      }
      proc.unref();
      count++;
    }
  }
  return { content: [{ type: 'text', text: 'ok' }] };
});
await server.connect(new StdioServerTransport());
