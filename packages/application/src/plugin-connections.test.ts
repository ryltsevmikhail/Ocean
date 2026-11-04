import { describe, expect, it } from 'vitest';
import {
  catalogFixture,
  PINNED_ADAPTER,
  serviceFixture,
  shippedTools,
  twoVersionCatalog,
} from '../test-fixtures/plugin-service.js';

describe('plugin connections', () => {
  it('keeps work and personal as distinct named references of one plugin', () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const work = fixture.connect({ name: 'work', accountLabel: 'Work account' });
    const personal = fixture.connect({ name: 'personal', credentialReference: 'OCEAN_TEST_OTHER' });
    expect(work.id).not.toBe(personal.id);
    expect(
      fixture.connections
        .list()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['personal', 'work']);
    expect(work.credentialReference).toBe('OCEAN_TEST_PRESENT');
    expect(work.accountLabel).toBe('Work account');
    expect(work.identityLabel).toBe('unverified');
    expect(() => fixture.connect({ name: 'work' })).toThrow('connection_exists');
    expect(() =>
      fixture.connections.add({
        name: 'bad name',
        pluginId: 'github',
        credentialReference: 'OCEAN_TEST_PRESENT',
      }),
    ).toThrow('invalid_connection_name');
    expect(() =>
      fixture.connections.add({
        name: 'leak',
        pluginId: 'github',
        credentialReference: 'ghp_canaryTokenValue',
      }),
    ).toThrow('invalid_credential_reference');
  });

  it('reports a user-supplied account label as unverified even after discovery', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect({ accountLabel: 'Work account' });
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    fixture.transport.catalog = () =>
      catalogFixture({ integrationId: 'github', connectionId: connection.id, owner: 'user' });
    const result = await fixture.connections.discover({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    expect(result.connection.accountLabel).toBe('Work account');
    expect(result.connection.identityLabel).toBe('unverified');
  });

  it('bumps the generation and revokes grants when the credential reference changes', async () => {
    const fixture = serviceFixture();
    fixture.state.members.add('ws_ocean|room_1|bot_dev');
    fixture.state.rooms.set('room_1', {
      id: 'room_1',
      kind: 'direct',
      title: null,
      participantCount: 2,
    });
    const connection = await fixture.readyWorkingConnection();
    const grant = fixture.access.grant({
      workspaceId: 'ws_ocean',
      roomId: 'room_1',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: connection.id,
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: false,
    });
    expect(fixture.state.grants.get(grant.id)?.state).toBe('active');
    const changed = fixture.connections.change({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
      credentialReference: 'OCEAN_TEST_PRESENT',
      accountLabel: 'Personal',
    });
    expect(changed.generation).toBe(connection.generation + 1);
    expect(changed.consented).toBe(false);
    expect(fixture.state.grants.get(grant.id)?.state).toBe('revoked');
    const discoverCalls = fixture.transport.discoverCalls;
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: changed.generation,
      }),
    ).rejects.toThrow('discovery_consent_required');
    expect(fixture.transport.discoverCalls).toBe(discoverCalls);
  });

  it('refuses the pinned endpoint override', () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    expect(() =>
      fixture.connections.change({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
        endpoint: 'https://evil.example/mcp/',
      }),
    ).toThrow('endpoint_locked');
  });

  it('disconnects immediately and idempotently with zero further admission', async () => {
    const fixture = serviceFixture();
    const connection = await fixture.readyWorkingConnection();
    const first = fixture.connections.disconnect(connection.id);
    expect(first.connection.state).toBe('disconnected');
    const second = fixture.connections.disconnect(connection.id);
    expect(second.connection.generation).toBe(first.connection.generation);
    expect(fixture.connections.get(connection.id).state).toBe('disconnected');
  });

  it('refuses plugin-version drift at discovery and demands renewed consent', async () => {
    const fixture = serviceFixture({ catalog: twoVersionCatalog() });
    fixture.installAndEnable();
    const connection = fixture.connect();
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    fixture.catalog.install({ pluginId: 'github', version: '1.1.0' });
    fixture.catalog.enable({ pluginId: 'github', version: '1.1.0' });
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('connection_changed');
    const changed = fixture.connections.get(connection.id);
    expect(changed.generation).toBe(connection.generation + 1);
    expect(changed.consented).toBe(false);
    expect(fixture.transport.discoverCalls).toBe(0);
  });

  it('invalidates active connections on a restored profile', async () => {
    const fixture = serviceFixture();
    const connection = await fixture.readyWorkingConnection();
    const restored = serviceFixture({ restored: true });
    restored.state.connections.add({ ...connection, state: 'active' });
    restored.connections.initialize();
    expect(restored.connections.get(connection.id).state).toBe('disconnected');
  });

  it('consumes one consent for exactly one discovery pass', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    fixture.transport.catalog = () =>
      catalogFixture({ integrationId: 'github', connectionId: connection.id, owner: 'user' });
    await fixture.connections.discover({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const calls = fixture.transport.discoverCalls;
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('discovery_consent_required');
    expect(fixture.transport.discoverCalls).toBe(calls);
    expect(fixture.connections.get(connection.id).consented).toBe(false);
  });

  it('rejects a discovery request that races a stale generation', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation + 1,
      }),
    ).rejects.toThrow('connection_changed');
    expect(fixture.transport.discoverCalls).toBe(0);
  });

  it('refuses discovery after an adapter build drift and keeps zero requests', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const drifted = fixture.restartWithAdapter({
      ...PINNED_ADAPTER,
      sdkVersion: '1.6.12',
    });
    await expect(
      drifted.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('plugin_not_enabled');
    expect(fixture.transport.discoverCalls).toBe(0);
  });
});

describe('plugin connection discovery publishes only declared tools', () => {
  it('refuses a catalog containing an undeclared tool', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    const extra = [
      ...shippedTools(),
      { name: 'create_issue', description: 'write', inputSchema: null },
    ];
    fixture.transport.catalog = () =>
      catalogFixture(
        { integrationId: 'github', connectionId: connection.id, owner: 'user' },
        { tools: extra },
      );
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('unexpected_tool');
    expect(fixture.state.counts.publishCalls).toBe(0);
  });
});
