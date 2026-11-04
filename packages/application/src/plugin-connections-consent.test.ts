import { describe, expect, it } from 'vitest';
import { ServicePluginDiscoveryRefusedError } from './service-plugin-transport.js';
import { catalogFixture, serviceFixture } from '../test-fixtures/plugin-service.js';

describe('plugin discovery consent', () => {
  it('requires explicit consent before any discovery request', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    const preview = fixture.connections.consentPreview(connection.id);
    expect(preview.endpoint).toBe('https://api.githubcopilot.com/mcp/');
    expect(preview.consented).toBe(false);
    expect(preview.prompt).toContain('https://api.githubcopilot.com/mcp/');
    expect(preview.prompt).toContain('metadata');
    expect(preview.prompt).toContain('4 MiB');
    expect(fixture.transport.discoverCalls).toBe(0);
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('discovery_consent_required');
    expect(fixture.transport.discoverCalls).toBe(0);
    expect(fixture.transport.invokeCalls).toBe(0);
    expect(fixture.connections.get(connection.id).schemaDigest).toBeNull();
  });

  it('publishes a schema digest only from one complete discovery', async () => {
    const fixture = serviceFixture();
    fixture.installAndEnable();
    const connection = fixture.connect();
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    fixture.transport.catalog = () => {
      throw new ServicePluginDiscoveryRefusedError('catalog_incomplete', 'incomplete listing');
    };
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('catalog_incomplete');
    expect(fixture.state.counts.publishCalls).toBe(0);
    expect(fixture.connections.get(connection.id).schemaDigest).toBeNull();
    // One consent authorizes exactly one discovery pass: a failure cannot be retried
    // silently. A digest-mismatched catalog is refused too and never published.
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    fixture.transport.catalog = () => ({
      ...catalogFixture({ integrationId: 'github', connectionId: connection.id, owner: 'user' }),
      schemaDigest: '0'.repeat(64),
    });
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('schema_digest_mismatch');
    expect(fixture.state.counts.publishCalls).toBe(0);
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    // A complete catalog publishes the exact digest and an honest identity label.
    fixture.transport.catalog = () =>
      catalogFixture(
        { integrationId: 'github', connectionId: connection.id, owner: 'user' },
        { identity: { identity: 'octocat', verified: true } },
      );
    const result = await fixture.connections.discover({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    expect(result.connection.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.connection.tools).toEqual(['list_issues', 'issue_read']);
    expect(result.connection.identity).toBe('octocat');
    expect(result.connection.identityLabel).toBe('verified');
    expect(result.authorityChanged).toBe(false);
    expect(fixture.transport.invokeCalls).toBe(0);
  });
});
