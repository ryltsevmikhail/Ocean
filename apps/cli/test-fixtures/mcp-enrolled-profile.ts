import { join } from 'node:path';
import { openSqliteStore } from '@runnets/store-sqlite';
import { OwnerScopeService } from '@runnets/application';
import type { ServiceConfiguration } from '@runnets/domain';
// eslint-disable-next-line no-restricted-imports -- Same-package CLI test fixture; CLI has no library export.
import { openOceanProfile } from '../src/ocean/profile.js';
import { connection } from '../../../packages/integrations-mcp/test-fixtures/admission.js';
/** Synthetic already-authorized profile; opening it performs no metadata I/O. */
export async function enrolledProfile(directory: string, configuration: ServiceConfiguration) {
  const profile = join(directory, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const command = (value: Parameters<typeof runtime.conversations.execute>[0]) => {
    const result = runtime.conversations.execute(value);
    if (!result.ok) throw Error('seed failed');
    return result.value;
  };
  command({
    type: 'BindWorkspace',
    workspaceId: 'ws_ocean',
    requestId: 'workspace',
    root: directory,
  });
  const bot = command({
    type: 'CreateBot',
    workspaceId: 'ws_ocean',
    requestId: 'bot',
    handle: 'dev',
    name: 'Dev',
    role: 'dev',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  if (bot.kind !== 'bot') throw Error('bot');
  const room = command({
    type: 'OpenDirectRoom',
    workspaceId: 'ws_ocean',
    requestId: 'room',
    botId: bot.data.id,
  });
  if (room.kind !== 'room') throw Error('room');
  const ownerId = runtime.ownerId!;
  const path = join(profile, 'runtime.sqlite');
  const store = openSqliteStore({ path });
  const c = connection(configuration, configuration.kind === 'stdio' ? null : 'env:SYNTHETIC');
  const owned = { ...c, trust: { ...c.trust, ownerId } };
  store.serviceAuthority.atomic((tx) => {
    tx.putConnection(owned, null);
    tx.putCatalog({
      id: 'seed_catalog',
      connectionId: c.id,
      configRevision: 1,
      trustRevision: 1,
      credentialRevision: 1,
      completeness: 'complete',
      observedAt: new Date().toISOString(),
      provenance: { fixture: 'owned' },
      tools: [
        {
          name: 'write',
          description: 'Synthetic',
          inputSchema: { type: 'object' },
          outputSchema: null,
          annotations: null,
          definitionDigest: 'a'.repeat(64),
          provenance: { fixture: 'owned' },
        },
      ],
    });
    tx.publishCatalog(c.id, c, 'seed_catalog');
  });
  new OwnerScopeService(store.serviceAuthority, ownerId, Date.now).issue({
    id: 'grant',
    subject: {
      workspaceId: 'ws_ocean',
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
        tools: { kind: 'exact', names: ['write'] },
        resources: [{ kind: 'connection', connectionId: c.id }],
      },
    ],
    limits: { maxCalls: 16, maxEffectBytes: 65536, expiresAt: null },
  });
  const before = store.serviceAuthority.atomic((tx) => ({
    connection: tx.connection(c.id),
    grants: tx.listGrants(),
  }));
  store.close();
  runtime.close();
  return { profile, path, before };
}
