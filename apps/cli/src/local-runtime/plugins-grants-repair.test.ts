import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch, host, seedRoom } from '../../test-fixtures/plugin-host-fixture.js';

describe('runtime plugin host repair and grant re-issue', () => {
  it('repairs a corrupt install over the runtime API and keeps it fail-closed', async () => {
    const { plugins, profile } = host();
    await dispatch(plugins, 'plugin.install', { pluginId: 'github' });
    await dispatch(plugins, 'plugin.enable', { pluginId: 'github' });
    // A damaged private copy is detected fail-closed and blocks enabling.
    chmodSync(join(profile, 'plugins', 'github', '1.0.0', 'manifest.json'), 0o644);
    await dispatch(plugins, 'plugin.disable', { pluginId: 'github' });
    const refused = (await plugins.dispatch('plugin.enable', { pluginId: 'github' })) as {
      error?: { code: string };
    };
    expect(refused.error?.code).toBe('install_corrupt');
    const corrupted = (await dispatch(plugins, 'plugin.inspect', {
      pluginId: 'github',
    })) as { installState: string; enabled: boolean; fileVerified: boolean };
    expect(corrupted).toMatchObject({
      installState: 'corrupt',
      enabled: false,
      fileVerified: false,
    });
    // Unrepaired state stays fail-closed: admission/version activation is impossible.
    const stillRefused = (await plugins.dispatch('plugin.enable', { pluginId: 'github' })) as {
      error?: { code: string };
    };
    expect(stillRefused.error?.code).toBe('install_not_verified');
    const repaired = (await dispatch(plugins, 'plugin.repair', {
      pluginId: 'github',
    })) as { state: string; verified: boolean; enabled: boolean };
    expect(repaired).toMatchObject({ state: 'installed', verified: true, enabled: false });
    expect(
      (await plugins.dispatch('plugin.repair', { pluginId: 'github' })) as {
        error?: { code: string };
      },
    ).toMatchObject({ error: { code: 'already_installed' } });
    const enabled = (await dispatch(plugins, 'plugin.enable', {
      pluginId: 'github',
    })) as { installed: { enabled: boolean } };
    expect(enabled.installed.enabled).toBe(true);
  });

  it('re-issues a grant atomically and reports real disconnect counts', async () => {
    const { plugins, store } = host();
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
    await dispatch(plugins, 'plugin.connection-discover', {
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const seeded = await seedRoom(store);
    const base = {
      workspaceId: 'ws_ocean',
      roomId: seeded.roomId,
      botId: seeded.botId,
      pluginId: 'github',
      connectionId: connection.id,
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    };
    const first = (await dispatch(plugins, 'plugin.access-grant', {
      ...base,
      tools: ['list_issues'],
    })) as { id: string; state: string };
    const second = (await dispatch(plugins, 'plugin.access-grant', {
      ...base,
      repository: 'team/other',
      tools: ['list_issues', 'issue_read'],
    })) as { id: string; state: string; repository: string };
    expect(first.state).toBe('active');
    expect(second.state).toBe('active');
    expect(second.repository).toBe('team/other');
    const grants = (await dispatch(plugins, 'plugin.access-list', {})) as {
      id: string;
      state: string;
    }[];
    expect(grants.filter((grant) => grant.state === 'active')).toHaveLength(1);
    expect(grants.find((grant) => grant.id === first.id)?.state).toBe('revoked');
    const disconnected = (await dispatch(plugins, 'plugin.connection-disconnect', {
      connectionId: connection.id,
    })) as { connection: { state: string }; revokedGrants: number };
    expect(disconnected.connection.state).toBe('disconnected');
    expect(disconnected.revokedGrants).toBe(1);
  });
});
