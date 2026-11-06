/** Owned synthetic normal-runtime proof. No real model/account or production profile. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, realpathSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '@runnets/store-sqlite';
import { OwnerScopeService, ConversationService, type ProviderPort } from '@runnets/application';
import type { ServiceConnection } from '@runnets/domain';
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { createRuntime } from '../dist/runtime.js';
const [proofArg, mode = 'http'] = process.argv.slice(2);
if (!proofArg) throw Error('proof directory required');
const proof = resolve(proofArg),
  profile = join(proof, 'profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });
const path = join(profile, 'runtime.sqlite');
writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
let calls = 0,
  effects = 0,
  model = 0,
  claims = 0;
const http = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const data of req) body += String(data);
    const message = JSON.parse(body) as { id?: string; method: string };
    if (!message.id) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'owned', version: '1' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'write',
            description: 'Synthetic operation',
            inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          },
        ],
      };
    else if (message.method === 'tools/call') {
      calls++;
      const db = new DatabaseSync(path);
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM tool_invocations_v2 WHERE outcome='started'")
        .get();
      db.close();
      claims += Number(rows?.['n']);
      appendFileSync(join(proof, 'received'), 'tools/call\n');
      effects++;
      appendFileSync(join(proof, 'effects'), 'effect\n');
      if (mode === 'drop') {
        res.destroy();
        return;
      }
      result = { content: [{ type: 'text', text: 'synthetic result' }] };
    } else throw Error('unexpected method');
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  } catch {
    res.writeHead(500).end();
  }
});
http.listen(0, '127.0.0.1');
await once(http, 'listening');
const address = http.address();
if (!address || typeof address === 'string') throw Error('address');
const store = openSqliteStore({ path });
let ids = 0;
const conversations = new ConversationService({
  store: store.conversations,
  clock: { now: () => new Date() },
  nextId: () => 'seed' + String(++ids),
});
function execute(command: Parameters<ConversationService['execute']>[0]) {
  const result = conversations.execute(command);
  if (!result.ok) throw Error('seed failed');
  return result.value;
}
execute({ type: 'BindWorkspace', requestId: 'workspace', workspaceId: 'ws', root: proof });
const bot = execute({
  type: 'CreateBot',
  requestId: 'bot',
  workspaceId: 'ws',
  handle: 'dev',
  name: 'Dev',
  role: 'dev',
  provider: 'deepseek',
  model: 'deepseek-flash',
});
if (bot.kind !== 'bot') throw Error('bot');
const room = execute({
  type: 'OpenDirectRoom',
  requestId: 'room',
  workspaceId: 'ws',
  botId: bot.data.id,
});
if (room.kind !== 'room') throw Error('room');
const ownerId = hash(realpathSync(path));
const at = new Date().toISOString();
let configuration: ServiceConnection['configuration'] = {
  kind: 'http',
  url: `http://127.0.0.1:${address.port}/mcp`,
};
if (mode === 'stdio') {
  const input = JSON.parse(readFileSync(join(proof, 'stdio.json'), 'utf8')) as {
    executable: string;
    sha256: string;
    packageJsonSha256: string;
    workspaceRoot: string;
  };
  configuration = { kind: 'stdio', ...input, args: ['/workspace'] };
}
store.serviceAuthority.atomic((tx) =>
  tx.putConnection(
    {
      id: 'connection',
      name: 'owned',
      configuration,
      credentialReference: null,
      trust: {
        ownerId,
        metadataPermission: 'allow',
        identity: { status: 'unverified', label: null },
        resourceEnforcement: [],
      },
      state: 'active',
      configRevision: 1,
      trustRevision: 1,
      credentialRevision: 1,
      currentCatalogId: null,
      createdAt: at,
      updatedAt: at,
    },
    null,
  ),
);
store.close();
const runtime = createRuntime({ dbPath: path });
await runtime.ready;
// Merely opening a generic reader does not discover.
const before = new DatabaseSync(path);
if (before.prepare('SELECT COUNT(*) AS n FROM ocean_service_catalogs').get()?.['n'] !== 0)
  throw Error('reader discovered');
before.close();
await runtime.services!.start();
const ownerStore = openSqliteStore({ path });
const c = ownerStore.serviceAuthority.atomic((tx) => tx.connection('connection'))!;
const current = ownerStore.serviceAuthority.atomic((tx) => tx.catalog(c.currentCatalogId!))!;
const tool = mode === 'stdio' ? 'read_file' : 'write';
if (!current.tools.some((t) => t.name === tool)) throw Error('missing tool');
new OwnerScopeService(ownerStore.serviceAuthority, ownerId, Date.now).issue({
  id: 'grant',
  subject: {
    workspaceId: 'ws',
    roomId: room.data.id,
    botId: bot.data.id,
    projectId: null,
    taskId: null,
  },
  permissions: [
    {
      kind: 'service',
      connectionId: c.id,
      trustRevision: 1,
      tools: { kind: 'exact', names: [tool] },
      resources: [{ kind: 'connection', connectionId: c.id }],
    },
  ],
  limits: { maxCalls: 16, maxEffectBytes: 1048576, expiresAt: null },
});
ownerStore.close();
await runtime.services!.drain();
runtime.close();
const provider: ProviderPort = {
  id: 'deepseek',
  models: ['deepseek-flash'],
  capabilities: { streaming: true, reasoning: false, usage: false, toolCalls: true },
  async *stream(request) {
    model++;
    if (request.messages.at(-1)?.role === 'tool')
      yield { type: 'text_delta', text: 'one final answer' };
    else {
      if (request.tools?.length !== 1) throw Error('neutral tool missing');
      yield {
        type: 'tool_call',
        call: {
          id: 'call',
          name: request.tools[0]!.name,
          arguments: JSON.stringify(
            mode === 'stdio' ? { path: '/workspace/canary.txt' } : { value: 'alpha' },
          ),
        },
      };
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    yield {
      type: 'completed',
      stopReason: request.messages.at(-1)?.role === 'tool' ? 'stop' : 'tool_calls',
      rawStopReason: 'scripted',
    };
  },
};
const host = await startLocalRuntime({ profile, provider });
const script = `import {connectLocalRuntime} from '@runnets/tools-node';
const c = await connectLocalRuntime({profile:process.argv[1]});
const q=JSON.parse(process.argv[2]);const r=await c.submit({...q,requestId:'independent',text:'call granted service'});
c.close();
const peer=await connectLocalRuntime({profile:process.argv[1]});
let view;for(let i=0;i<500;i++){view=await peer.getRun({...q,runId:r.runId});if(!['queued','running','preparing'].includes(view?.taskStatus))break;await new Promise(r=>setTimeout(r,10));}
const history=await peer.history({...q,after:0,limit:20});peer.close();console.log(JSON.stringify({view,answers:history.filter(m=>m.author==='bot').map(m=>m.body)}));`;
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    script,
    profile,
    JSON.stringify({ workspaceId: 'ws', roomId: room.data.id, to: bot.data.id }),
  ],
  { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
);
let stdout = '',
  stderr = '';
child.stdout.on('data', (b: Buffer) => {
  stdout += b.toString();
});
child.stderr.on('data', (b: Buffer) => {
  stderr += b.toString();
});
const [code] = await once(child, 'exit');
const stopped = await host.stop();
http.closeAllConnections();
await new Promise<void>((r) => http.close(() => r()));
if (code !== 0) throw Error('client failed ' + stderr);
const client = JSON.parse(stdout) as { answers: string[]; view: { taskStatus: string } };
const result = { mode, calls, effects, claims, model, client, stopped };
writeFileSync(join(proof, 'result.json'), JSON.stringify(result, null, 2) + '\n');
if (
  mode === 'http' &&
  (calls !== 1 || effects !== 1 || claims !== 1 || model !== 2 || client.answers.length !== 1)
)
  throw Error('normal path failed');
if (
  mode === 'drop' &&
  (calls !== 1 || effects !== 1 || claims !== 1 || model !== 1 || client.answers.length !== 0)
)
  throw Error('uncertainty replayed');
if (mode === 'stdio' && (model !== 2 || client.answers.length !== 1))
  throw Error('native normal path failed');
console.log(JSON.stringify(result));
