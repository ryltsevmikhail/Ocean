import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Platform from '@runnets/tools-node';
import type { ServiceConnection } from '@runnets/domain';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { startLocalRuntime } from './host.js';
const prepared = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@runnets/tools-node', async (original) => ({
  ...(await original<typeof Platform>()),
  verifyManagedStdioEnrollments: async () => {},
  // Exercise the real SDK stdio protocol using owned pinned JS; existing native isolation is a separate gate.
  prepareManagedStdio: async (r: Parameters<typeof Platform.prepareManagedStdio>[0]) => {
    expect(createHash('sha256').update(readFileSync(r.artifact)).digest('hex')).toBe(r.sha256);
    prepared.calls++;
    const witness = await (
      await original<typeof Platform>()
    ).openManagedWorkspace(r.workspace, r.signal);
    const nonce = randomUUID(),
      unit = 'ocean-mcp-' + 'a'.repeat(32) + '-' + nonce + '.service';
    return {
      nonce,
      unit,
      cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit,
      footprint: witness.footprint,
      inspect: () => witness.inspect(),
      preparationSignal: r.signal,
      deadlineAt: r.deadlineAt ?? Date.now() + 15000,
      running: async () => true,
      parameters: { command: process.execPath, args: [r.artifact], env: {}, stderr: 'pipe' },
      start() {},
      async observe() {},
      async cleanup() {
        await witness.close();
        return 'confirmed';
      },
    };
  },
}));
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
it('owner API persists an enrolled pinned stdio declaration and refreshes metadata through the existing SDK transport', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const workspaceRoot = join(f.root, 'workspace');
  mkdirSync(workspaceRoot);
  const executable = join(f.root, 'owned-server.mjs');
  const source = `import {createInterface} from 'node:readline';
  for await (const line of createInterface({input:process.stdin})) {
    const r=JSON.parse(line);if(r.id===undefined)continue;
    const result=r.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned',version:'1'}}:r.method==='tools/list'?{tools:[{name:'read',description:'Owned metadata',inputSchema:{type:'object'}}]}:{};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
  }`;
  writeFileSync(executable, source, { mode: 0o600 });
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  const set = (await peer.request('service.connection-set', {
    requestId: 'enroll',
    connectionId: 'stdio',
    expectedVersions: null,
    name: 'Owned stdio',
    metadataPermission: 'allow',
    configuration: {
      kind: 'stdio',
      executable,
      workspaceRoot,
      sha256: createHash('sha256').update(source).digest('hex'),
      args: [],
    },
  })) as { result: ServiceConnection };
  expect(prepared.calls).toBe(0);
  const c = set.result;
  const request = {
    requestId: 'refresh',
    connectionId: 'stdio',
    expectedVersions: {
      configRevision: c.configRevision,
      trustRevision: c.trustRevision,
      credentialRevision: c.credentialRevision,
    },
  };
  expect(await peer.request('service.connection-refresh', request)).toMatchObject({
    state: 'completed',
    result: { id: 'stdio', configRevision: 2 },
  });
  expect(prepared.calls).toBe(1);
  expect(await peer.request('service.connections', {})).toMatchObject([{ tools: ['read'] }]);
  await peer.request('service.connection-refresh', request);
  expect(prepared.calls).toBe(1);
});
