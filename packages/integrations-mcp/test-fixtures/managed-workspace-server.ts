import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { appendFileSync, readFileSync, writeFileSync, watch, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
const tick = (name: string) => appendFileSync('/workspace/' + name, '1\n', { flush: true });
tick('startup'); // Deliberately before initialize, discovery and any business grant.
const config = JSON.parse(readFileSync('/workspace/fixture.json', 'utf8')) as { mode: string };
writeFileSync(
  '/workspace/namespace.json',
  JSON.stringify({
    pid: process.pid,
    stat: readFileSync('/proc/self/stat', 'utf8'),
    mounts: readFileSync('/proc/self/mountinfo', 'utf8'),
  }),
);
if (config.mode === 'idle' || config.mode === 'drop') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs=require('node:fs');
    const watcher=fs.watch('/workspace',()=>{if(fs.existsSync('/workspace/idle-release')){fs.appendFileSync('/workspace/idle','1\\n',{flush:true});watcher.close();}});
    fs.writeFileSync('/workspace/idle-ready','ready');
  `,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}
const server = new Server(
  { name: 'managed-workspace', version: '1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler('tools/list', () => ({
  tools: [{ name: 'write', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }],
}));
server.setRequestHandler('tools/call', async () => {
  tick('mutation');
  if (config.mode === 'drop') process.exit(23);
  if (config.mode === 'hold')
    await new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync('/workspace/call-release')) {
          watcher.close();
          resolve();
        }
      };
      const watcher = watch('/workspace', check);
      check();
    });
  return { content: [{ type: 'text', text: 'alpha' }], structuredContent: { version: 'alpha' } };
});
const transport = new StdioServerTransport();
await server.connect(transport);
const receive = transport.onmessage;
transport.onmessage = (message) => {
  if ('method' in message && message.method === 'tools/call') tick('received');
  receive?.(message);
};
