import { describe, expect, it } from 'vitest';
import type { ChatTurn } from '@runnets/domain';
import { serviceFixture } from '../test-fixtures/plugin-service.js';

const bot = (id: string) => ({
  id,
  workspaceId: 'ws_ocean',
  handle: id,
  name: id,
  role: 'reviewer',
  provider: 'deepseek',
  model: 'deepseek-flash',
  profileVersion: 1,
});

const turn = (botId = 'bot_dev', roomId = 'room_1'): ChatTurn => ({
  id: 'turn_1',
  workspaceId: 'ws_ocean',
  roomId,
  requestId: 'req_1',
  taskRunId: 'run_1',
  inboundMessageId: 'message_1',
  readThroughSeq: 1,
  bot: bot(botId),
  status: 'accepted',
  text: '',
  preparedVersion: null,
  stopReason: 'end_turn',
});
const context = { taskRunId: 'run_1', attemptId: 'attempt_1' };

function seedMembers(fixture: ReturnType<typeof serviceFixture>) {
  fixture.state.members.add('ws_ocean|room_1|bot_dev');
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
}

async function fixtureWithGrant(tools = ['list_issues', 'issue_read']) {
  const fixture = serviceFixture();
  seedMembers(fixture);
  const connection = await fixture.readyWorkingConnection();
  const grant = fixture.access.grant({
    workspaceId: 'ws_ocean',
    roomId: 'room_1',
    botId: 'bot_dev',
    pluginId: 'github',
    connectionId: connection.id,
    tools,
    repository: 'team/api',
    acknowledgeGroupVisibility: false,
  });
  return { fixture, connection, grant };
}

describe('granted plugin tool source', () => {
  it('exposes only the addressed bot grants in the addressed room', async () => {
    const { fixture, grant } = await fixtureWithGrant(['list_issues']);
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    expect(tools).not.toBeNull();
    expect(tools!.definitions.map((definition) => definition.name)).toEqual(['list_issues']);
    expect(tools!.cleanupConfirmed).toBe(true);
    expect(tools!.instructions).toContain('team/api');
    expect(tools!.instructions).toContain('list_issues');
    expect(
      await fixture.tools.forTurn(turn('bot_review'), new AbortController().signal),
    ).toBeNull();
    expect(
      await fixture.tools.forTurn(turn('bot_dev', 'room_2'), new AbortController().signal),
    ).toBeNull();
    expect(grant.state).toBe('active');
  });

  it('returns no tools when the profile has no grants (plugin-disabled behavior)', async () => {
    const fixture = serviceFixture();
    expect(await fixture.tools.forTurn(turn(), new AbortController().signal)).toBeNull();
  });

  it('binds the granted repository exactly and dispatches one business request', async () => {
    const { fixture, grant } = await fixtureWithGrant(['list_issues']);
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    const result = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: JSON.stringify({}) },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(false);
    expect(fixture.transport.invokeCalls).toBe(1);
    expect(fixture.transport.invocations[0]?.arguments).toEqual({ owner: 'team', repo: 'api' });
    const operation = fixture.operations.list()[0]!;
    expect(operation).toMatchObject({
      state: 'observed',
      tool: 'list_issues',
      repository: 'team/api',
      connectionGeneration: 1,
      outcomeCode: 'ok',
    });
    expect(operation.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(operation.endpoint).toContain('https://');
    expect(operation.id).toBe('attempt_1_plugin_call_1');
    expect(grant.state).toBe('active');
    // A repeat with the same invocation identity returns the original outcome.
    const repeat = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: JSON.stringify({}) },
      new AbortController().signal,
      context,
    );
    expect(repeat.output).toBe(result.output);
    expect(fixture.transport.invokeCalls).toBe(1);
  });

  it('refuses unknown/extra argument fields and a mismatched repository before claim', async () => {
    const { fixture } = await fixtureWithGrant(['issue_read']);
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    const unknown = await tools!.execute(
      { id: 'call_1', name: 'issue_read', arguments: JSON.stringify({ write: true }) },
      new AbortController().signal,
      context,
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('invalid_arguments');
    const foreign = await tools!.execute(
      {
        id: 'call_2',
        name: 'issue_read',
        arguments: JSON.stringify({ owner: 'evil', repo: 'other' }),
      },
      new AbortController().signal,
      context,
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.output).toContain('repository_mismatch');
    const ungranted = await tools!.execute(
      { id: 'call_3', name: 'write_thing', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(ungranted.isError).toBe(true);
    expect(ungranted.output).toContain('tool_ungranted');
    expect(fixture.transport.invokeCalls).toBe(0);
    expect(fixture.operations.list()).toHaveLength(0);
  });

  it('refuses the seventeenth call visibly with zero further dispatch', async () => {
    const { fixture } = await fixtureWithGrant(['list_issues']);
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    for (let index = 0; index < 16; index++) {
      const result = await tools!.execute(
        { id: 'call_' + String(index), name: 'list_issues', arguments: '{}' },
        new AbortController().signal,
        context,
      );
      expect(result.isError).toBe(false);
    }
    const refused = await tools!.execute(
      { id: 'call_16', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain('call_limit');
    expect(refused.uncertain).not.toBe(true);
    expect(fixture.transport.invokeCalls).toBe(16);
    expect(fixture.operations.list()).toHaveLength(16);
  });

  it('preserves uncertainty and never retries a dropped reply', async () => {
    const { fixture } = await fixtureWithGrant(['list_issues']);
    fixture.transport.invocation = () => ({
      kind: 'uncertain',
      invocationId: 'inv',
      code: 'transport_failure',
      detail: 'connection lost after dispatch',
    });
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    const first = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(first.uncertain).toBe(true);
    expect(first.output).toContain('uncertain');
    expect(fixture.transport.invokeCalls).toBe(1);
    expect(fixture.operations.list()[0]?.state).toBe('uncertain');
    // A different request identity cannot spend the held effect: the journal refuses it.
    const second = await tools!.execute(
      { id: 'call_2', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      { taskRunId: 'run_2', attemptId: 'attempt_2' },
    );
    expect(second.isError).toBe(true);
    expect(second.output).toContain('journal_refused');
    expect(fixture.transport.invokeCalls).toBe(1);
    expect(fixture.operations.openCount()).toBe(1);
  });

  it('truncates model-visible output with an explicit marker and byte count', async () => {
    const { fixture } = await fixtureWithGrant(['list_issues']);
    fixture.transport.invocation = () => ({
      kind: 'observed',
      invocationId: 'inv',
      code: 'ok',
      result: { data: 'x'.repeat(40_000) },
      vendorErrorCode: null,
    });
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    const result = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('[truncated: kept ');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    const operation = fixture.operations.list()[0]!;
    expect(operation.truncated).toBe(true);
    expect(operation.resultBytes).toBeGreaterThan(32 * 1024);
  });

  it('maps a proven pre-dispatch refusal to a stable non-uncertain error', async () => {
    const { fixture } = await fixtureWithGrant(['list_issues']);
    fixture.transport.invocation = () => ({
      kind: 'not_started',
      invocationId: 'inv',
      code: 'execution_disabled',
      detail: 'disabled',
    });
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    const result = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.uncertain).not.toBe(true);
    expect(result.output).toContain('execution_disabled');
    expect(fixture.operations.list()[0]?.state).toBe('not_started');
  });

  it('cannot spend permission that was revoked after the tool list was resolved', async () => {
    const { fixture, connection, grant } = await fixtureWithGrant(['list_issues']);
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    fixture.access.revoke(grant.id);
    const result = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('grant_revoked');
    expect(fixture.transport.invokeCalls).toBe(0);
    expect(fixture.operations.list()).toHaveLength(0);
    expect(fixture.state.connections.get(connection.id)?.state).toBe('active');
  });

  it('refuses a stale connection generation after any authority change', async () => {
    const { fixture, connection } = await fixtureWithGrant(['list_issues']);
    const tools = await fixture.tools.forTurn(turn(), new AbortController().signal);
    // Another client bumped the connection generation without revoking this grant row.
    const current = fixture.state.connectionRows.get(connection.id)!;
    fixture.state.connectionRows.set(connection.id, {
      ...current,
      generation: current.generation + 1,
    });
    const result = await tools!.execute(
      { id: 'call_1', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('grant_mismatch');
    expect(fixture.transport.invokeCalls).toBe(0);
  });
});
