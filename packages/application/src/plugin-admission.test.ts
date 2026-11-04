import { describe, expect, it } from 'vitest';
import { serviceFixture, PINNED_ADAPTER } from '../test-fixtures/plugin-service.js';
import type { PluginCallRequest } from './plugin-admission.js';

async function fixtureWithGrant() {
  const fixture = serviceFixture();
  fixture.state.members.add('ws_ocean|room_1|bot_dev');
  fixture.state.members.add('ws_ocean|room_2|bot_dev');
  fixture.state.rooms.set('room_1', {
    id: 'room_1',
    kind: 'direct',
    title: null,
    participantCount: 2,
  });
  fixture.state.rooms.set('room_2', {
    id: 'room_2',
    kind: 'group',
    title: 'Other',
    participantCount: 3,
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
  const call = (overrides: Partial<PluginCallRequest> = {}): PluginCallRequest => ({
    workspaceId: 'ws_ocean',
    roomId: 'room_1',
    botId: 'bot_dev',
    pluginId: 'github',
    connectionId: connection.id,
    grantId: grant.id,
    tool: 'list_issues',
    arguments: { owner: 'team', repo: 'api' },
    claim: {
      invocationId: 'invocation-1',
      taskRunId: 'run-1',
      attemptId: 'attempt-1',
    },
    ...overrides,
  });
  return { fixture, connection, grant, call };
}

describe('plugin call admission', () => {
  it('dispatches exactly one business request after a durable claim', async () => {
    const { fixture, call } = await fixtureWithGrant();
    const result = await fixture.admission.call(call());
    expect(result.admitted).toBe(true);
    expect(result.code).toBe('admitted');
    expect(result.grantId).toBeTruthy();
    expect(result.connectionGeneration).toBeGreaterThanOrEqual(1);
    expect(result.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.outcome?.kind).toBe('observed');
    expect(result.settled).toBe(true);
    expect(fixture.transport.invokeCalls).toBe(1);
    expect(fixture.state.settled.get('invocation-1')).toBe('completed');
    expect(fixture.transport.invocations[0]?.arguments).toEqual({ owner: 'team', repo: 'api' });
  });

  it('produces zero business requests for every denial path', async () => {
    const cases: {
      name: string;
      call: (input: PluginCallRequest) => PluginCallRequest;
      code: string;
    }[] = [
      {
        name: 'not a member',
        call: (input) => ({ ...input, botId: 'bot_review' }),
        code: 'member_required',
      },
      {
        name: 'unknown connection',
        call: (input) => ({ ...input, connectionId: 'missing' }),
        code: 'connection_unknown',
      },
      {
        name: 'unknown grant',
        call: (input) => ({ ...input, grantId: 'missing' }),
        code: 'grant_unknown',
      },
      {
        name: 'wrong room',
        call: (input) => ({ ...input, roomId: 'room_2' }),
        code: 'grant_mismatch',
      },
      {
        name: 'wrong bot in same room',
        call: (input) => ({ ...input, botId: 'bot_review' }),
        code: 'member_required',
      },
      {
        name: 'wrong repository',
        call: (input) => ({
          ...input,
          arguments: { owner: 'team', repo: 'other' },
        }),
        code: 'grant_mismatch',
      },
      {
        name: 'tool not granted',
        call: (input) => ({ ...input, tool: 'issue_read' }),
        code: 'grant_mismatch',
      },
      {
        name: 'invalid arguments without a repository',
        call: (input) => ({ ...input, arguments: {} }),
        code: 'invalid_arguments',
      },
      {
        name: 'arguments over the request cap',
        call: (input) => ({
          ...input,
          arguments: { owner: 'team', repo: 'api', filler: 'x'.repeat(1024 * 1024) },
        }),
        code: 'arguments_too_large',
      },
      { name: 'adapter build changed', call: (input) => input, code: 'plugin_not_enabled' },
      { name: 'plugin disabled', call: (input) => input, code: 'plugin_not_enabled' },
    ];
    for (const scenario of cases) {
      const { fixture, call } = await fixtureWithGrant();
      if (scenario.name === 'adapter build changed') {
        const restarted = fixture.restartWithAdapter({ ...PINNED_ADAPTER, sdkVersion: '1.6.12' });
        const input = scenario.call(call());
        const result = await restarted.admission.call(input);
        expect(result.code, scenario.name).toBe(scenario.code);
        expect(result.admitted, scenario.name).toBe(false);
        expect(restarted.transport.invokeCalls, scenario.name).toBe(0);
        continue;
      }
      if (scenario.name === 'plugin disabled') {
        fixture.catalog.disable({ pluginId: 'github' });
        const input = scenario.call(call());
        const result = await fixture.admission.call(input);
        expect(result.code, scenario.name).toBe(scenario.code);
        expect(fixture.transport.invokeCalls, scenario.name).toBe(0);
        continue;
      }
      const result = await fixture.admission.call(scenario.call(call()));
      expect(result.code, scenario.name).toBe(scenario.code);
      expect(result.admitted, scenario.name).toBe(false);
      expect(result.outcome, scenario.name).toBeNull();
      expect(fixture.transport.invokeCalls, scenario.name).toBe(0);
    }
  });

  it('refuses a revoked grant with zero business requests', async () => {
    const { fixture, call, grant } = await fixtureWithGrant();
    fixture.access.revoke(grant.id);
    const result = await fixture.admission.call(call());
    expect(result.code).toBe('grant_revoked');
    expect(fixture.transport.invokeCalls).toBe(0);
  });

  it('refuses a stale-generation grant after the connection authority moved', async () => {
    const { fixture, call, grant, connection } = await fixtureWithGrant();
    fixture.connections.change({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
      accountLabel: 'Other account',
    });
    const result = await fixture.admission.call(call());
    expect(result.code).toBe('grant_revoked');
    expect(fixture.transport.invokeCalls).toBe(0);
    expect(fixture.state.grants.get(grant.id)?.state).toBe('revoked');
  });

  it('refuses a missing credential reference without any dispatch', async () => {
    const fixture = serviceFixture();
    fixture.state.members.add('ws_ocean|room_1|bot_dev');
    fixture.state.rooms.set('room_1', {
      id: 'room_1',
      kind: 'direct',
      title: null,
      participantCount: 2,
    });
    fixture.installAndEnable();
    const connection = fixture.connect({ credentialReference: 'OCEAN_TEST_ABSENT' });
    fixture.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    fixture.transport.catalog = () => {
      const target = {
        integrationId: 'github',
        connectionId: connection.id,
        owner: 'user' as const,
      };
      return {
        target,
        tools: [
          { name: 'list_issues', description: 'list', inputSchema: null },
          { name: 'issue_read', description: 'read', inputSchema: null },
        ],
        schemaDigest: '',
        account: { identity: null, verified: false },
        discoveredAt: '2026-11-04T00:00:00.000Z',
        completeness: 'complete',
      };
    };
    // Discovery itself refuses without a present credential reference.
    await expect(
      fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow('credential_unavailable');
    expect(fixture.transport.discoverCalls).toBe(0);
  });

  it('refuses a repeated invocation identity through the durable journal', async () => {
    const { fixture, call } = await fixtureWithGrant();
    fixture.state.claims.set('invocation-1', 'seeded');
    const result = await fixture.admission.call(call());
    expect(result.code).toBe('journal_refused');
    expect(fixture.transport.invokeCalls).toBe(0);
  });

  it('retains uncertainty after one dispatch and never retries', async () => {
    const { fixture, call } = await fixtureWithGrant();
    let attempts = 0;
    fixture.transport.invocation = () => {
      attempts++;
      return {
        kind: 'uncertain',
        invocationId: 'invocation-1',
        code: 'transport_failure',
        detail: 'dropped after write',
      };
    };
    const result = await fixture.admission.call(call());
    expect(result.admitted).toBe(true);
    expect(result.outcome?.kind).toBe('uncertain');
    expect(result.settled).toBe(true);
    expect(fixture.state.settled.get('invocation-1')).toBe('uncertain');
    expect(attempts).toBe(1);
    expect(fixture.transport.invokeCalls).toBe(1);
    const second = await fixture.admission.call({
      ...call(),
      claim: { ...call().claim },
    });
    expect(second.code).toBe('journal_refused');
    expect(fixture.transport.invokeCalls).toBe(1);
  });

  it('treats a throwing transport as uncertain without a retry', async () => {
    const { fixture, call } = await fixtureWithGrant();
    fixture.transport.invocation = () => {
      throw new Error('adapter crashed');
    };
    const result = await fixture.admission.call(call());
    expect(result.outcome?.kind).toBe('uncertain');
    expect(result.settled).toBe(true);
    expect(fixture.transport.invokeCalls).toBe(1);
  });
});
