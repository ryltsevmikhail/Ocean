import { describe, expect, it } from 'vitest';
import { serviceFixture } from '../test-fixtures/plugin-service.js';
import { PluginRefusedError } from './plugin-ports.js';

async function fixtureWithUncertainOperation() {
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
  fixture.transport.invocation = () => ({
    kind: 'uncertain',
    invocationId: 'inv',
    code: 'transport_failure',
    detail: 'connection lost after dispatch',
  });
  const call = (invocationId: string) =>
    fixture.admission.call({
      workspaceId: 'ws_ocean',
      roomId: 'room_1',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: connection.id,
      grantId: grant.id,
      tool: 'list_issues',
      arguments: { owner: 'team', repo: 'api' },
      claim: { invocationId, taskRunId: 'run_1', attemptId: 'attempt_1' },
    });
  await call('attempt_1_plugin_call_1');
  return { fixture, grant, call };
}

describe('durable plugin operations', () => {
  it('lists and shows bounded operation records', async () => {
    const { fixture } = await fixtureWithUncertainOperation();
    const operations = fixture.operations.list();
    expect(operations).toHaveLength(1);
    const operation = operations[0]!;
    expect(operation.state).toBe('uncertain');
    expect(operation.connectionGeneration).toBe(1);
    expect(operation.endpoint).toContain('https://');
    expect(operation.argumentsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(operation.resultBytes).toBeNull();
    expect(fixture.operations.show(operation.id)).toEqual(operation);
    expect(fixture.operations.openCount()).toBe(1);
    expect(() => fixture.operations.show('missing')).toThrow(PluginRefusedError);
  });

  it('acknowledges only an uncertain operation, with an explicit revision', async () => {
    const { fixture, call } = await fixtureWithUncertainOperation();
    const operation = fixture.operations.list()[0]!;
    expect(() =>
      fixture.operations.acknowledge({
        operationId: operation.id,
        expectedRevision: operation.revision + 1,
      }),
    ).toThrow(/operation_conflict/);
    const acknowledged = fixture.operations.acknowledge({
      operationId: operation.id,
      expectedRevision: operation.revision,
      reason: 'checked the room by hand',
    });
    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.revision).toBe(operation.revision + 1);
    expect(acknowledged.acknowledgedReason).toBe('checked the room by hand');
    // The unknown outcome is preserved; nothing claims remote certainty.
    expect(acknowledged.outcomeCode).toBe('transport_failure');
    expect(acknowledged.settledAt).not.toBeNull();
    expect(() =>
      fixture.operations.acknowledge({
        operationId: operation.id,
        expectedRevision: acknowledged.revision,
      }),
    ).toThrow(/operation_not_uncertain/);
    // Replay of a completed operation is still refused.
    expect(fixture.operations.show(operation.id).detail).toContain('connection lost');
    // The journal hold is released: a fresh invocation identity can be claimed again.
    fixture.transport.invocation = () => ({
      kind: 'observed',
      invocationId: 'inv',
      code: 'ok',
      result: { ok: true },
      vendorErrorCode: null,
    });
    const next = await call('attempt_2_plugin_call_1');
    expect(next.admitted).toBe(true);
    expect(fixture.transport.invokeCalls).toBe(2);
  });

  it('never lets a restored mainland acknowledge an unknown effect', () => {
    const fixture = serviceFixture({ restored: true });
    expect(() =>
      fixture.operations.acknowledge({ operationId: 'missing', expectedRevision: 1 }),
    ).toThrow(/restore_restricted/);
  });

  it('lowers a crashed started operation to uncertain without replay', async () => {
    const { fixture } = await fixtureWithUncertainOperation();
    const operation = fixture.operations.list()[0]!;
    // Simulate a crash before settlement: the row is `started`.
    const row = fixture.state.operationRows.get(operation.id)!;
    fixture.state.operationRows.set(operation.id, { ...row, state: 'started', settledAt: null });
    fixture.state.resolvedRows.delete(operation.id);
    fixture.state.settled.delete(operation.id);
    const recovered = fixture.operations.recover();
    expect(recovered.lowered).toBe(1);
    const after = fixture.operations.show(operation.id);
    expect(after.state).toBe('uncertain');
    expect(after.outcomeCode).toBe('interrupted');
    expect(after.detail).toContain('restarted');
    expect(after.revision).toBe(operation.revision + 1);
    expect(fixture.operations.openCount()).toBe(1);
  });
});
