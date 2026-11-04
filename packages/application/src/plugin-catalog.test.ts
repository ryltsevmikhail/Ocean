import { afterEach, describe, expect, it } from 'vitest';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';
import {
  PINNED_ADAPTER,
  serviceFixture,
  shippedTools,
  twoVersionCatalog,
} from '../test-fixtures/plugin-service.js';

const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;

afterEach(() => {
  // never leave a network stub behind
});

describe('plugin catalog install', () => {
  it('installs the shipped card with zero network requests and records it disabled', () => {
    const fixture = serviceFixture();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls++;
      throw new Error('install must not use the network');
    }) as typeof globalThis.fetch;
    try {
      const installed = fixture.catalog.install({ pluginId: 'github' });
      expect(installed.state).toBe('installed');
      expect(installed.enabled).toBe(false);
      expect(installed.verified).toBe(true);
      expect(installed.manifestDigest).toBe(entry.manifestDigest);
      expect(fixture.transport.discoverCalls).toBe(0);
      expect(fixture.transport.invokeCalls).toBe(0);
      expect(fetchCalls).toBe(0);
      const view = fixture.catalog.inspect('github');
      expect(view.installed).toBe(true);
      expect(view.enabled).toBe(false);
      expect(view.fileVerified).toBe(true);
      expect(view.tools).toEqual(['list_issues', 'issue_read']);
      expect(JSON.stringify(fixture.catalog.search('git'))).toContain('GitHub issues (read-only)');
      expect(fixture.catalog.search('nope')).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses a manifest whose bytes do not hash to the pinned digest', () => {
    const tampered = {
      ...SHIPPED_PLUGIN_CATALOG,
      entries: [{ ...entry, manifestDigest: 'f'.repeat(64) }],
    };
    const fixture = serviceFixture({ catalog: tampered });
    expect(() => fixture.catalog.install({ pluginId: 'github' })).toThrow(
      'manifest_digest_mismatch',
    );
    expect(fixture.state.versions.size).toBe(0);
    expect(fixture.state.installFiles.read('github', entry.version).status).toBe('missing');
  });

  it('refuses an incompatible adapter before publishing anything', () => {
    const fixture = serviceFixture({
      adapter: { ...PINNED_ADAPTER, sdkVersion: '1.6.10' },
    });
    expect(() => fixture.catalog.install({ pluginId: 'github' })).toThrow('adapter_incompatible');
    expect(fixture.state.versions.size).toBe(0);
    expect(fixture.state.installFiles.read('github', entry.version).status).toBe('missing');
  });

  it('records an interrupted install when the private publication fails', () => {
    const fixture = serviceFixture();
    fixture.state.failFilePublish(new Error('disk full'));
    expect(() => fixture.catalog.install({ pluginId: 'github' })).toThrow('install_failed');
    expect(fixture.catalog.inspect('github').installState).toBe('interrupted');
    expect(fixture.catalog.inspect('github').enabled).toBe(false);
  });

  it('records corruption when the written copy does not verify', () => {
    const fixture = serviceFixture();
    fixture.state.overrideFileDigest('e'.repeat(64));
    expect(() => fixture.catalog.install({ pluginId: 'github' })).toThrow('install_unverified');
    expect(fixture.catalog.inspect('github').installState).toBe('corrupt');
  });

  it('enables and disables an installed verified version', () => {
    const fixture = serviceFixture();
    fixture.catalog.install({ pluginId: 'github' });
    expect(fixture.catalog.enable({ pluginId: 'github' }).installed.enabled).toBe(true);
    expect(fixture.catalog.enabled('github')?.version).toBe(entry.version);
    expect(fixture.catalog.disable({ pluginId: 'github' }).enabled).toBe(false);
    expect(fixture.catalog.enabled('github')).toBeNull();
  });

  it('does not enable a version whose private copy was corrupted after install', () => {
    const fixture = serviceFixture();
    fixture.catalog.install({ pluginId: 'github' });
    fixture.state.corruptInstalled('github', entry.version);
    expect(() => fixture.catalog.enable({ pluginId: 'github' })).toThrow('install_corrupt');
    expect(fixture.catalog.inspect('github').enabled).toBe(false);
  });
});

describe('plugin catalog restart recovery', () => {
  it('opens only a verified version, always disabled, after restart', () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    expect(fixture.catalog.enabled('github')).not.toBeNull();
    const restarted = serviceFixture();
    // Same durable rows are shared by transferring the maps into the fresh fixture state.
    restarted.state.catalog.beginInstall({
      ...fixture.state.catalog.version('github', entry.version)!,
      state: 'installed',
      enabled: true,
    });
    restarted.state.installFiles.publish('github', entry.version, entry.manifest);
    restarted.catalog.initialize();
    const view = restarted.catalog.inspect('github');
    expect(view.installState).toBe('installed');
    expect(view.enabled).toBe(false);
    expect(view.fileVerified).toBe(true);
  });

  it('recovers an interrupted install whose atomic copy already verified', () => {
    const fixture = serviceFixture();
    fixture.catalog.install({ pluginId: 'github' });
    fixture.state.catalog.setState('github', entry.version, 'installing');
    fixture.catalog.initialize();
    expect(fixture.catalog.inspect('github').installState).toBe('installed');
    expect(fixture.catalog.inspect('github').enabled).toBe(false);
  });

  it('revokes dormant grants when the host adapter build no longer matches the pin', async () => {
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
    const drifted = fixture.restartWithAdapter({ ...PINNED_ADAPTER, sdkVersion: '1.6.12' });
    // Startup recovery of the incompatible adapter has already revoked the grant.
    expect(fixture.state.grants.get(grant.id)?.state).toBe('revoked');
    expect(drifted.catalog.enabled('github')).toBeNull();
    expect(drifted.catalog.inspect('github').enabled).toBe(false);
  });

  it('marks a lost private copy corrupt and revokes its authority', () => {
    const fixture = serviceFixture({ catalog: twoVersionCatalog() });
    fixture.catalog.install({ pluginId: 'github', version: entry.version });
    fixture.catalog.enable({ pluginId: 'github', version: entry.version });
    fixture.state.corruptInstalled('github', entry.version);
    const report = fixture.catalog.initialize();
    expect(report.corrupt).toBeGreaterThanOrEqual(1);
    expect(fixture.catalog.inspect('github', entry.version).installState).toBe('corrupt');
    expect(fixture.catalog.enabled('github')).toBeNull();
  });

  it('refuses to enable a switched-to version whose pinned copy does not verify', () => {
    const fixture = serviceFixture({ catalog: twoVersionCatalog() });
    fixture.catalog.install({ pluginId: 'github', version: entry.version });
    fixture.catalog.enable({ pluginId: 'github', version: entry.version });
    fixture.catalog.install({ pluginId: 'github', version: '1.1.0' });
    fixture.state.corruptInstalled('github', '1.1.0');
    expect(() => fixture.catalog.enable({ pluginId: 'github', version: '1.1.0' })).toThrow(
      'install_corrupt',
    );
  });
});

describe('plugin catalog version switch', () => {
  it('revokes active grants and pending confirmations when the enabled version changes', async () => {
    const fixture = serviceFixture({ catalog: twoVersionCatalog() });
    fixture.state.members.add('ws_ocean|room_1|bot_dev');
    fixture.state.rooms.set('room_1', {
      id: 'room_1',
      kind: 'group',
      title: 'Team',
      participantCount: 3,
    });
    const connection = await fixture.readyWorkingConnection();
    expect(connection.schemaDigest).not.toBeNull();
    const grant = fixture.access.grant({
      workspaceId: 'ws_ocean',
      roomId: 'room_1',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: connection.id,
      tools: [...shippedTools().map((tool) => tool.name)],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
    expect(fixture.state.grants.get(grant.id)?.state).toBe('active');
    fixture.state.access.seedPendingConfirmation(
      'confirmation-1',
      connection.id,
      connection.generation,
      '2026-11-04T00:00:00.000Z',
    );
    fixture.catalog.install({ pluginId: 'github', version: '1.1.0' });
    const switched = fixture.catalog.enable({ pluginId: 'github', version: '1.1.0' });
    expect(switched.revokedGrants).toBeGreaterThanOrEqual(1);
    expect(fixture.state.grants.get(grant.id)?.state).toBe('revoked');
    expect(fixture.state.confirmations.get('confirmation-1')?.state).toBe('revoked');
  });
});
