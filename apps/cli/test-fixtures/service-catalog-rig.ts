/* eslint-disable no-restricted-imports -- Same-app fixture exercises the normal public host. */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { openSqliteStore } from '@runnets/store-sqlite';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { ProviderPort } from '@runnets/application';
import { startLocalRuntime } from '../src/local-runtime/host.js';
import { privateRoot, completedRun } from './local-provider-host.test.js';
import { configureService, confirmedProvider, journal } from './service-confirmation-rig.js';
import { serviceOwnerPeer } from './service-owner-peer.js';

export async function catalogRig() {
  const f = await privateRoot();
  const path = join(f.profile, 'runtime.sqlite');
  const controls = {
    extra: false,
    description: 'Synthetic',
    notify: false,
    initializeGate: null as Promise<void> | null,
    holdModel: null as Promise<void> | null,
    selectedName: null as string | null,
    onCall: null as (() => void) | null,
  };
  const current = () => {
    const store = openSqliteStore({ path });
    try {
      return store.serviceAuthority.atomic((tx) => {
        const connection = tx.connection('test');
        return {
          connection,
          catalog: connection?.currentCatalogId ? tx.catalog(connection.currentCatalogId) : null,
          grants: tx.listGrants(),
        };
      });
    } finally {
      store.close();
    }
  };
  const traffic: { method: string; revision: number; permission: string; claims: number }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const m = JSON.parse(body) as { id?: number; method: string };
    const c = current().connection;
    traffic.push({
      method: m.method,
      revision: c?.configRevision ?? 0,
      permission: c?.trust.metadataPermission ?? 'missing',
      claims: journal(f.profile).length,
    });
    if (m.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (m.method === 'initialize') {
      await controls.initializeGate;
      res.setHeader('mcp-session-id', 'owned-fixture');
    }
    const tool = {
      name: 'write',
      description: controls.description,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    };
    const result =
      m.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'owned-catalog', version: '1' },
          }
        : m.method === 'tools/list'
          ? { tools: controls.extra ? [tool, { ...tool, name: 'ungranted' }] : [tool] }
          : m.method === 'tools/call'
            ? {
                content: [{ type: 'text', text: 'alpha' }],
                structuredContent: { version: 'alpha' },
              }
            : undefined;
    if (m.method === 'tools/call') controls.onCall?.();
    const reply = { jsonrpc: '2.0', id: m.id, result };
    if (m.method === 'tools/call' && controls.notify) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: message\ndata: ' +
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/tools/list_changed',
            params: {},
          }) +
          '\n\n',
      );
      res.end('event: message\ndata: ' + JSON.stringify(reply) + '\n\n');
    } else if (result === undefined) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: 'unsupported' },
        }),
      );
    } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  const p = confirmedProvider();
  let snapshots = 0;
  const provider: ProviderPort = {
    ...p.provider,
    async *stream(request) {
      if (request.messages.at(-1)?.role !== 'tool') {
        snapshots++;
        await controls.holdModel;
      }
      for await (const event of p.provider.stream(request))
        yield event.type === 'tool_call' && controls.selectedName
          ? { ...event, call: { ...event.call, name: controls.selectedName } }
          : event;
    },
  };
  const host = await startLocalRuntime({ profile: f.profile, provider });
  await configureService(f, `http://127.0.0.1:${String(address.port)}/mcp`, 'autonomous');
  const owner = await serviceOwnerPeer(f.profile);
  const client = await connectLocalRuntime({ profile: f.profile });
  let sequence = 0;
  return {
    f,
    controls,
    current,
    traffic,
    host,
    owner,
    client,
    denyMetadata() {
      const store = openSqliteStore({ path });
      try {
        store.serviceAuthority.atomic((tx) => {
          const c = tx.connection('test')!;
          if (
            !tx.putConnection(
              {
                ...c,
                trustRevision: c.trustRevision + 1,
                trust: { ...c.trust, metadataPermission: 'none' },
              },
              c,
            )
          )
            throw Error('revoke failed');
        });
      } finally {
        store.close();
      }
    },
    facts: p.facts,
    snapshots: () => snapshots,
    calls: () => traffic.filter((t) => t.method === 'tools/call'),
    async submit() {
      return client.submit({
        workspaceId: 'ws_ocean',
        roomId: f.roomId,
        requestId: 'turn' + String(++sequence),
        text: 'call',
      });
    },
    async complete(runId: string) {
      return completedRun(client, f, runId);
    },
    async refresh() {
      const c = current().connection!;
      return owner.request('service.connection-refresh', {
        requestId: 'refresh' + String(++sequence),
        connectionId: c.id,
        expectedVersions: {
          configRevision: c.configRevision,
          trustRevision: c.trustRevision,
          credentialRevision: c.credentialRevision,
        },
      });
    },
    async close() {
      client.close();
      owner.close();
      await host.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.dispose();
    },
  };
}
