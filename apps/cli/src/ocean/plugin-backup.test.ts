import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SHIPPED_PLUGIN_CATALOG, canonicalJson } from '@runnets/domain';
import {
  PluginAccessService,
  PluginCallAdmissionService,
  PluginCatalogService,
  PluginConnectionService,
} from '@runnets/application';
import { inspectDatabase } from '@runnets/store-sqlite';
import {
  createEnvironmentCredentialReferences,
  createPluginInstallStore,
} from '@runnets/tools-node';
import { fakePluginTransport } from '../../../../packages/application/test-fixtures/plugin-fakes.js';
import { backupProfile, restoreProfile } from './snapshots.js';
import {
  canary,
  cleanupFixture,
  close,
  context,
  credentialReference,
  entry,
  env,
  hashFile,
  initializeProfile,
  open,
  PINNED,
  profileAt,
  root,
  seedConversation,
  sha256,
  tools,
} from '../../test-fixtures/plugin-backup-fixtures.js';

afterEach(cleanupFixture);

function context() {
  let n = 100;
  return {
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => 'x' + String(++n),
    sha256,
  };
}

describe('plugin profile backup and restore', () => {
  it('backs up plugin data without secrets and restores it inert', async () => {
    const directory = root();
    const profile = profileAt(directory);
    initializeProfile(profile);
    const store = open(profile);
    const seeded = await seedConversation(store);
    const files = createPluginInstallStore({ profile });
    const catalog = new PluginCatalogService({
      catalog: SHIPPED_PLUGIN_CATALOG,
      store: store.pluginCatalog,
      files,
      adapter: PINNED,
      ...context(),
    });
    catalog.initialize();
    catalog.install({ pluginId: 'github' });
    catalog.enable({ pluginId: 'github' });
    const catalogTools = tools();
    const digest = sha256(
      canonicalJson([...catalogTools].sort((a, b) => (a.name < b.name ? -1 : 1))),
    );
    const transport = fakePluginTransport(
      (target) => ({
        target: target ?? { integrationId: 'github', connectionId: '', owner: 'user' },
        tools: catalogTools,
        schemaDigest: digest,
        account: { identity: 'octocat', verified: true },
        discoveredAt: '2026-11-04T00:00:00.000Z',
        completeness: 'complete',
      }),
      () => ({
        kind: 'observed',
        invocationId: 'inv',
        code: 'ok',
        result: {},
        vendorErrorCode: null,
      }),
    );
    const credentials = createEnvironmentCredentialReferences(env);
    const connections = new PluginConnectionService({
      store: store.pluginConnections,
      versions: catalog,
      transport,
      credentials,
      adapter: PINNED,
      ...context(),
    });
    const connection = connections.add({
      name: 'work',
      pluginId: 'github',
      credentialReference,
      accountLabel: 'Work',
    });
    connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const discovered = await connections.discover({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const access = new PluginAccessService({ store: store.pluginAccess, ...context() });
    const grant = access.grant({
      workspaceId: 'ws_ocean',
      roomId: seeded.roomId,
      botId: seeded.botId,
      pluginId: 'github',
      connectionId: discovered.connection.id,
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
    expect(grant.state).toBe('active');
    expect(store.pluginCatalog.enabled('github')).not.toBeNull();
    close(store);

    const summary = inspectDatabase(join(profile, 'runtime.sqlite'));
    expect(summary.status).toBe('ok');
    if (summary.status === 'ok') expect(summary.summary.pluginAssets).toBe(1);

    const archive = join(directory, 'archive');
    await backupProfile(profile, archive, { managedDirectory: join(directory, 'managed') });
    const archivedManifest = join(
      archive,
      'assets',
      'plugins',
      'github',
      entry.version,
      'manifest.json',
    );
    expect(existsSync(archivedManifest)).toBe(true);
    expect(hashFile(archivedManifest)).toBe(entry.manifestDigest);
    const scan = (path: string): string => {
      let text = '';
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        if (statSync(child).isDirectory()) text += scan(child);
        else text += readFileSync(child).toString('binary');
      }
      return text;
    };
    const archiveBytes = scan(archive);
    expect(archiveBytes).not.toContain(canary);
    expect(archiveBytes).toContain(credentialReference);

    const restored = join(directory, 'restored');
    restoreProfile(archive, restored);
    expect(statSync(join(restored, 'plugins', 'github', entry.version)).mode & 0o777).toBe(0o700);
    expect(hashFile(join(restored, 'plugins', 'github', entry.version, 'manifest.json'))).toBe(
      entry.manifestDigest,
    );
    const restoredStore = open(restored);
    expect(restoredStore.pluginConnections.get(connection.id)?.state).toBe('disconnected');
    expect(restoredStore.pluginConnections.consents(connection.id)).toEqual([]);
    const restoredGrants = restoredStore.pluginAccess.grants();
    expect(restoredGrants.length).toBeGreaterThanOrEqual(1);
    expect(restoredGrants.every((row) => row.state === 'revoked')).toBe(true);
    const restoredCatalog = new PluginCatalogService({
      catalog: SHIPPED_PLUGIN_CATALOG,
      store: restoredStore.pluginCatalog,
      files: createPluginInstallStore({ profile: restored }),
      adapter: PINNED,
      restored: true,
      ...context(),
    });
    restoredCatalog.initialize();
    expect(restoredCatalog.inspect('github').enabled).toBe(false);
    const restoredAdmission = new PluginCallAdmissionService({
      store: restoredStore.pluginAdmission,
      transport,
      credentials,
      adapter: PINNED,
    });
    const denied = await restoredAdmission.call({
      workspaceId: 'ws_ocean',
      roomId: seeded.roomId,
      botId: seeded.botId,
      pluginId: 'github',
      connectionId: connection.id,
      grantId: grant.id,
      tool: 'list_issues',
      arguments: { owner: 'team', repo: 'api' },
      claim: {
        invocationId: 'restored-invocation',
        taskRunId: 'restored-run',
        attemptId: 'attempt',
      },
    });
    expect(denied.admitted).toBe(false);
    expect(transport.invokeCalls).toBe(0);
  });

  it('refuses explicitly when a verified plugin manifest cannot be backed up', async () => {
    const directory = root();
    const profile = profileAt(directory);
    initializeProfile(profile);
    const store = open(profile);
    const catalog = new PluginCatalogService({
      catalog: SHIPPED_PLUGIN_CATALOG,
      store: store.pluginCatalog,
      files: createPluginInstallStore({ profile }),
      adapter: PINNED,
      ...context(),
    });
    catalog.initialize();
    catalog.install({ pluginId: 'github' });
    close(store);
    rmSync(join(profile, 'plugins', 'github', entry.version), { recursive: true, force: true });
    await expect(
      backupProfile(profile, join(directory, 'archive-missing'), {
        managedDirectory: join(directory, 'managed'),
      }),
    ).rejects.toThrow('plugin_assets_unavailable');
  });
});
