import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isLocalPluginCatalogView,
  isLocalPluginCatalogViews,
  isLocalPluginConsentPreview,
  isLocalPluginDiscoveryResult,
  isLocalPluginInstalledView,
} from '@runnets/contracts';
import { openSqliteStore, type SqliteStore } from '@runnets/store-sqlite';
import { canonicalJson } from '@runnets/domain';
import { fakePluginTransport } from '../../../../packages/application/test-fixtures/plugin-fakes.js';
import { runtimePluginsHost, type RuntimePlugins } from './plugins.js';

const directories: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function host(options: { restored?: boolean; env?: Record<string, string | undefined> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-plugin-host-'));
  directories.push(directory);
  const profile = join(directory, 'profile');
  const store = openSqliteStore({ path: join(directory, 'runtime.sqlite') });
  stores.push(store);
  const tools = [
    { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
    { name: 'issue_read', description: 'Read issue', inputSchema: { type: 'object' } },
  ];
  const digest = sha256(canonicalJson([...tools].sort((a, b) => (a.name < b.name ? -1 : 1))));
  const transport = fakePluginTransport(
    (target) => ({
      target,
      tools,
      schemaDigest: digest,
      account: { identity: 'octocat', verified: true },
      discoveredAt: '2026-11-04T00:00:00.000Z',
      completeness: 'complete',
    }),
    () => ({
      kind: 'observed',
      invocationId: 'inv',
      code: 'ok',
      result: { ok: true },
      vendorErrorCode: null,
    }),
  );
  const plugins = runtimePluginsHost({
    profile,
    stores: {
      catalog: store.pluginCatalog,
      connections: store.pluginConnections,
      access: store.pluginAccess,
    },
    restored: options.restored ?? false,
    env: options.env ?? { OCEAN_PLUGIN_TOKEN: 'fixture-only' },
    transport,
    now: () => Date.parse('2026-11-04T00:00:00.000Z'),
  });
  return { store, plugins, transport, profile, directory, tools, digest };
}

function data(reply: { result?: unknown; error?: { code: string } }): unknown {
  if (reply.error) throw Error(reply.error.code);
  return reply.result;
}

async function dispatch(
  plugins: RuntimePlugins,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const reply = await plugins.dispatch(method, params);
  return data(reply as { result?: unknown; error?: { code: string } });
}

describe('runtime plugin host dispatch', () => {
  it('installs the pinned card over the wire with zero transport requests', async () => {
    const { plugins, transport } = host();
    const catalog = (await dispatch(plugins, 'plugin.catalog', {})) as unknown[];
    expect(Array.isArray(catalog)).toBe(true);
    expect(isLocalPluginCatalogView(catalog[0])).toBe(true);
    expect(isLocalPluginCatalogViews(catalog)).toBe(true);
    const installed = await dispatch(plugins, 'plugin.install', { pluginId: 'github' });
    expect(isLocalPluginInstalledView(installed)).toBe(true);
    expect((installed as { enabled: boolean }).enabled).toBe(false);
    expect(transport.discoverCalls).toBe(0);
    expect(transport.invokeCalls).toBe(0);
    const enabled = (await dispatch(plugins, 'plugin.enable', { pluginId: 'github' })) as {
      installed: { enabled: boolean };
    };
    expect(enabled.installed.enabled).toBe(true);
    const disabled = await dispatch(plugins, 'plugin.disable', { pluginId: 'github' });
    expect((disabled as { enabled: boolean }).enabled).toBe(false);
  });

  it('maps malformed params and unknown plugins to stable refusal codes', async () => {
    const { plugins } = host();
    const malformed = (await plugins.dispatch('plugin.install', { bad: true })) as {
      error?: { code: string };
    };
    expect(malformed.error?.code).toBe('invalid_params');
    const unknown = (await plugins.dispatch('plugin.inspect', { pluginId: 'missing' })) as {
      error?: { code: string };
    };
    expect(unknown.error?.code).toBe('unknown_plugin');
    const unknownMethod = (await plugins.dispatch('plugin.nope', {})) as {
      error?: { code: string };
    };
    expect(unknownMethod.error?.code).toBe('invalid_params');
  });

  it('runs consent-gated discovery and returns exact owner-facing grant DTOs', async () => {
    const { plugins, transport } = host();
    await dispatch(plugins, 'plugin.install', { pluginId: 'github' });
    await dispatch(plugins, 'plugin.enable', { pluginId: 'github' });
    const connection = (await dispatch(plugins, 'plugin.connection-add', {
      name: 'work',
      pluginId: 'github',
      credentialReference: 'OCEAN_PLUGIN_TOKEN',
    })) as { id: string; generation: number };
    const preview = await dispatch(plugins, 'plugin.connection-preview', {
      connectionId: connection.id,
    });
    expect(isLocalPluginConsentPreview(preview)).toBe(true);
    const refused = (await plugins.dispatch('plugin.connection-discover', {
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    })) as { error?: { code: string } };
    expect(refused.error?.code).toBe('discovery_consent_required');
    expect(transport.discoverCalls).toBe(0);
    const consented = await dispatch(plugins, 'plugin.connection-consent', {
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    expect((consented as { consented: boolean }).consented).toBe(true);
    const discovered = await dispatch(plugins, 'plugin.connection-discover', {
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    expect(isLocalPluginDiscoveryResult(discovered)).toBe(true);
    const connections = (await dispatch(plugins, 'plugin.connections', {})) as unknown[];
    expect(Array.isArray(connections)).toBe(true);
    expect(transport.discoverCalls).toBe(1);
    expect(transport.invokeCalls).toBe(0);
  });

  it('refuses owner mutations on a restored host', async () => {
    const { plugins } = host({ restored: true });
    const reply = (await plugins.dispatch('plugin.install', { pluginId: 'github' })) as {
      error?: { code: string };
    };
    expect(reply.error?.code).toBe('restore_restricted');
    const catalog = await dispatch(plugins, 'plugin.catalog', {});
    expect(Array.isArray(catalog)).toBe(true);
  });

  it('keeps the credential value out of every wire reply', async () => {
    const canary = 'CANARY_PLUGIN_CREDENTIAL_3f982a';
    const { plugins } = host({ env: { OCEAN_PLUGIN_TOKEN: canary } });
    await dispatch(plugins, 'plugin.install', { pluginId: 'github' });
    await dispatch(plugins, 'plugin.enable', { pluginId: 'github' });
    const connection = await dispatch(plugins, 'plugin.connection-add', {
      name: 'work',
      pluginId: 'github',
      credentialReference: 'OCEAN_PLUGIN_TOKEN',
    });
    const replies = [
      await dispatch(plugins, 'plugin.catalog', {}),
      await dispatch(plugins, 'plugin.connections', {}),
      await dispatch(plugins, 'plugin.connection-preview', {
        connectionId: (connection as { id: string }).id,
      }),
    ];
    const serialized = JSON.stringify(replies);
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain('OCEAN_PLUGIN_TOKEN');
  });
});
