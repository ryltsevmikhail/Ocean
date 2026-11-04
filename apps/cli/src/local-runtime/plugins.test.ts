import { describe, expect, it, vi } from 'vitest';
import {
  isLocalPluginCatalogView,
  isLocalPluginCatalogViews,
  isLocalPluginConsentPreview,
  isLocalPluginDiscoveryResult,
  isLocalPluginInstalledView,
} from '@runnets/contracts';
import { dispatch, host } from '../../test-fixtures/plugin-host-fixture.js';

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

  it('drains an in-flight discovery and refuses new owner mutations while draining', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { plugins, transport } = host({ discoverGate: gate });
    await dispatch(plugins, 'plugin.install', { pluginId: 'github' });
    await dispatch(plugins, 'plugin.enable', { pluginId: 'github' });
    const connection = (await dispatch(plugins, 'plugin.connection-add', {
      name: 'work',
      pluginId: 'github',
      credentialReference: 'OCEAN_PLUGIN_TOKEN',
    })) as { id: string; generation: number };
    await dispatch(plugins, 'plugin.connection-consent', {
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const inFlight = plugins.dispatch('plugin.connection-discover', {
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    await vi.waitFor(() => expect(transport.discoverCalls).toBe(1));
    let drained = false;
    const drain = plugins.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The drain waits for the owner discovery instead of discarding its effect.
    expect(drained).toBe(false);
    expect(await plugins.dispatch('plugin.install', { pluginId: 'github' })).toMatchObject({
      error: { code: 'runtime_draining' },
    });
    // Sync reads stay available while the effect drains.
    expect(await plugins.dispatch('plugin.catalog', {})).toHaveProperty('result');
    release();
    await drain;
    expect(drained).toBe(true);
    expect(await inFlight).toHaveProperty('result');
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

  it('serves the durable operation journal and the versioned owner acknowledgement', async () => {
    const { plugins, store } = host();
    const context = { taskRunId: 'run_1', attemptId: 'attempt_1' };
    const id = 'attempt_1_plugin_call_1';
    await store.tools.claim(id, 'list_issues', context, 'fingerprint');
    store.pluginAdmission.atomic((tx) => {
      tx.beginOperation({
        id,
        taskRunId: 'run_1',
        attemptId: 'attempt_1',
        workspaceId: 'ws_ocean',
        roomId: 'room_1',
        botId: 'bot_dev',
        pluginId: 'github',
        connectionId: 'conn_work',
        connectionGeneration: 1,
        endpoint: 'https://api.githubcopilot.com/mcp/',
        tool: 'list_issues',
        repository: 'team/api',
        schemaDigest: 'a'.repeat(64),
        argumentsDigest: 'b'.repeat(64),
        arguments: '{"owner":"team","repo":"api"}',
        state: 'started',
        outcomeCode: null,
        detail: null,
        resultSummary: null,
        resultBytes: null,
        truncated: false,
        revision: 1,
        createdAt: '2026-11-04T00:00:00.000Z',
        settledAt: null,
        acknowledgedAt: null,
        acknowledgedReason: null,
      });
      return undefined;
    });
    store.pluginAdmission.settleOperation(
      id,
      {
        state: 'uncertain',
        outcomeCode: 'transport_failure',
        detail: 'connection lost after dispatch',
        resultSummary: null,
        resultBytes: null,
        truncated: false,
        settledAt: '2026-11-04T00:00:01.000Z',
      },
      'uncertain',
      context,
    );
    const list = (await dispatch(plugins, 'plugin.operations-list', {
      roomId: 'room_1',
    })) as readonly { id: string; state: string; revision: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, state: 'uncertain', revision: 2 });
    const show = await dispatch(plugins, 'plugin.operation-show', { operationId: id });
    expect((show as { endpoint: string }).endpoint).toBe('https://api.githubcopilot.com/mcp/');
    const acknowledged = (await dispatch(plugins, 'plugin.operation-acknowledge', {
      operationId: id,
      expectedRevision: 2,
      reason: 'checked by hand',
    })) as { state: string; acknowledgedReason: string };
    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.acknowledgedReason).toBe('checked by hand');
    expect(await store.tools.pending()).toHaveLength(0);
    expect(
      (
        (await plugins.dispatch('plugin.operation-acknowledge', {
          operationId: id,
          expectedRevision: 3,
        })) as { error?: { code: string } }
      ).error?.code,
    ).toBe('operation_not_uncertain');
  });

  it('keeps operation reads available in restore mode and mutations refused', async () => {
    const { plugins } = host({ restored: true });
    expect(Array.isArray(await dispatch(plugins, 'plugin.operations-list', {}))).toBe(true);
    const reply = (await plugins.dispatch('plugin.operation-acknowledge', {
      operationId: 'missing',
      expectedRevision: 1,
    })) as { error?: { code: string } };
    expect(reply.error?.code).toBe('restore_restricted');
  });
});
