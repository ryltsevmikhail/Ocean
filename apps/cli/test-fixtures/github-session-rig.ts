/* eslint-disable no-restricted-imports -- Same-app loopback fixture exercises its host composition. */
/** Counted synthetic accounts behind the real public host and Executor adapter. */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import type { PluginRuntime } from '../src/plugin-runtime.js';
import { composeRuntimePlugins } from '../src/runtime-plugins.js';
import { openExecutorPluginTransport } from '../src/plugin-transport.js';
import { clock, seedConversations, seeded, turnFor } from './real-adapter-rig.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

export async function sessionRig() {
  const observations: { method: string; account: string; tools: string; readonly: string }[] = [];
  const controls = {
    extra: false,
    missing: false,
    duplicate: false,
    refuseReadonly: false,
    schemaRevision: 1,
    modern: false,
    toolStatus: 200,
    notifyToolsChanged: false,
    initializeGate: null as Promise<void> | null,
    listGate: null as Promise<void> | null,
    callGate: null as Promise<void> | null,
  };
  const definitions = () => {
    const tools = [
      {
        name: 'issue_read',
        description: 'Read an issue ' + String(controls.schemaRevision),
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', 'x-mcp-header': 'owner' },
            repo: { type: 'string', 'x-mcp-header': 'repo' },
            method: { type: 'string', enum: ['get'] },
            issue_number: { type: 'number' },
          },
          required: ['owner', 'repo', 'method', 'issue_number'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues',
        inputSchema: {
          type: 'object',
          properties: { owner: { type: 'string' }, repo: { type: 'string' } },
          required: ['owner', 'repo'],
        },
      },
    ];
    if (controls.missing) tools.pop();
    if (controls.extra) tools.push({ ...tools[0]!, name: 'issue_write' });
    if (controls.duplicate) tools.push(tools[0]!);
    return tools;
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk as Uint8Array));
    const message = JSON.parse(Buffer.concat(buffers).toString()) as {
      id?: number;
      method: string;
      params?: { arguments?: Record<string, unknown> };
    };
    const account =
      req.headers.authorization === 'Bearer synthetic-account-A'
        ? 'A'
        : req.headers.authorization === 'Bearer synthetic-account-B'
          ? 'B'
          : 'unknown';
    observations.push({
      method: message.method,
      account,
      tools: String(req.headers['x-mcp-tools'] ?? ''),
      readonly: String(req.headers['x-mcp-readonly'] ?? ''),
    });
    if (controls.refuseReadonly) {
      res.writeHead(403).end();
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/list') await controls.listGate;
    if (message.method === 'initialize') await controls.initializeGate;
    if (message.method === 'tools/call') await controls.callGate;
    if (
      message.method === 'tools/call' &&
      (controls.toolStatus !== 200 ||
        (req.headers['mcp-protocol-version'] === '2026-07-28' &&
          req.headers['mcp-param-owner'] === undefined))
    ) {
      res.writeHead(controls.toolStatus === 200 ? 400 : controls.toolStatus, {
        'content-type': 'application/json',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32020, message: 'Header mismatch' },
        }),
      );
      return;
    }
    const result =
      message.method === 'server/discover' && controls.modern
        ? {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: { listChanged: true } },
            _meta: {
              'io.modelcontextprotocol/serverInfo': { name: 'account-fixture', version: '1' },
            },
          }
        : message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'account-fixture', version: '1.0.0' },
            }
          : message.method === 'tools/list'
            ? { tools: definitions(), ttlMs: 60_000, cacheScope: 'private' }
            : message.method === 'tools/call'
              ? {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        account,
                        marker: 'fixture-account-' + account,
                        repository:
                          String(message.params?.arguments?.['owner']) +
                          '/' +
                          String(message.params?.arguments?.['repo']),
                      }),
                    },
                  ],
                  isError: false,
                }
              : undefined;
    if (message.method === 'tools/call' && controls.notifyToolsChanged) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: message\ndata: ' +
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/tools/list_changed',
          }) +
          '\n\n',
      );
      res.end(
        'event: message\ndata: ' +
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) +
          '\n\n',
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        result === undefined
          ? {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'unsupported' },
            }
          : { jsonrpc: '2.0', id: message.id, result },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw Error('fixture_address');
  const endpoint = `http://127.0.0.1:${String(address.port)}/mcp`;
  const directory = mkdtempSync(join(tmpdir(), 'ogh-'));
  const store = openSqliteStore({ path: join(directory, 'runtime.sqlite') });
  seedConversations(store);
  const env: Record<string, string> = {
    OCEAN_ACCOUNT_A: 'synthetic-account-A',
    OCEAN_ACCOUNT_B: 'synthetic-account-B',
  };
  const open = async () =>
    composeRuntimePlugins({
      profile: join(directory, 'profile'),
      store,
      clock,
      restored: false,
      env,
      transport: await openExecutorPluginTransport({
        env,
        endpointOverride: endpoint,
        connection: (id) => store.pluginConnections.get(id),
      }),
    });
  let runtime: PluginRuntime = await open();
  cleanups.push(async () => {
    await runtime.shutdown();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  runtime.services.catalog.install({ pluginId: 'github' });
  runtime.services.catalog.enable({ pluginId: 'github' });
  const added = runtime.services.connections.add({
    name: 'account',
    pluginId: 'github',
    credentialReference: 'OCEAN_ACCOUNT_A',
  });
  const connection = () => runtime.services.connections.get(added.id);
  const grant = (tools = ['issue_read', 'list_issues']) =>
    runtime.services.access.grant({
      workspaceId: 'ws',
      roomId: seeded.room,
      botId: seeded.dev,
      pluginId: 'github',
      connectionId: added.id,
      tools,
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
  const discover = () => {
    const current = connection();
    const request = { connectionId: added.id, expectedGeneration: current.generation };
    runtime.services.connections.consent(request);
    return runtime.services.connections.discover(request);
  };
  let calls = 0;
  const execute = async () => {
    const tools = await runtime.tools?.forTurn(turnFor(), new AbortController().signal);
    if (tools === null || tools === undefined) throw Error('no_granted_tools');
    return tools.execute(
      {
        id: 'call' + String(++calls),
        name: 'issue_read',
        arguments: JSON.stringify({ method: 'get', issue_number: 5 }),
      },
      new AbortController().signal,
      { taskRunId: 'run_1', attemptId: 'attempt_1' },
    );
  };
  return {
    get runtime() {
      return runtime;
    },
    store,
    env,
    controls,
    observations,
    connection,
    grant,
    discover,
    execute,
    business: () => observations.filter((entry) => entry.method === 'tools/call'),
    async restart() {
      await runtime.shutdown();
      runtime = await open();
    },
  };
}
