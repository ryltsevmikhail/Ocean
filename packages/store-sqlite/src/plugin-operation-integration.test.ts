import { describe, expect, it } from 'vitest';
import { at, entry, fixture, sha256 } from '../test-fixtures/plugin-operation-rig.js';
describe('durable plugin operation journal (real SQLite)', () => {
  it('records exactly one operation row for one allowed call and settles it observed', async () => {
    const { db, journal, operations, counts, call, grant } = fixture();
    const result = await call('attempt-1_plugin_call_1');
    expect(result.admitted).toBe(true);
    expect(counts.invoke).toBe(1);
    expect(journal.inspectPending()).toHaveLength(0);
    const rows = operations.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'attempt-1_plugin_call_1',
      workspaceId: 'ws',
      roomId: 'room',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: 'conn_work',
      connectionGeneration: 1,
      endpoint: entry.manifest.endpoint,
      tool: 'list_issues',
      repository: 'team/api',
      state: 'observed',
      outcomeCode: 'ok',
      revision: 2,
      truncated: false,
    });
    expect(rows[0]?.schemaDigest).toBe('a'.repeat(64));
    expect(rows[0]?.argumentsDigest).toBe(sha256('{"owner":"team","repo":"api"}'));
    expect(rows[0]?.settledAt).toBe(at);
    expect(rows[0]?.resultSummary).toContain('"number":7');
    // No grant id or credential material is duplicated into the operation row.
    const columns = db
      .prepare('PRAGMA table_info(ocean_plugin_operations)')
      .all()
      .map((row) => String(row['name']));
    expect(columns).not.toContain('grant_id');
    expect(columns).not.toContain('credential_reference');
    expect(operations.show(rows[0]!.id)).toEqual(rows[0]);
    // A replayed admission for the same invocation identity never dispatches twice.
    const replay = await call('attempt-1_plugin_call_1');
    expect(replay.admitted).toBe(false);
    expect(replay.code).toBe('journal_refused');
    expect(counts.invoke).toBe(1);
    expect(grant.state).toBe('active');
    expect(db.prepare('SELECT count(*) AS n FROM ocean_plugin_operations').get()?.['n']).toBe(1);
  });

  it('keeps a dropped reply uncertain, holds every new claim and never redispatches', async () => {
    const { journal, operations, counts, call } = fixture(() => ({
      kind: 'uncertain',
      invocationId: 'inv',
      code: 'transport_failure',
      detail: 'socket closed after dispatch',
    }));
    const first = await call('attempt-1_plugin_call_1');
    expect(first.outcome?.kind).toBe('uncertain');
    expect(counts.invoke).toBe(1);
    expect(operations.list()[0]?.state).toBe('uncertain');
    expect(journal.inspectPending()).toHaveLength(1);
    // Even a different request identity cannot spend the unknown effect.
    const second = await call('attempt-9_plugin_call_1');
    expect(second.admitted).toBe(false);
    expect(second.code).toBe('journal_refused');
    expect(counts.invoke).toBe(1);
    expect(operations.openCount()).toBe(1);
  });

  it('releases only the acknowledged hold while preserving the uncertain record', async () => {
    const { journal, operations, counts, call } = fixture(() => ({
      kind: 'uncertain',
      invocationId: 'inv',
      code: 'transport_failure',
      detail: 'socket closed after dispatch',
    }));
    await call('attempt-1_plugin_call_1');
    const operation = operations.list()[0]!;
    const acknowledged = operations.acknowledge({
      operationId: operation.id,
      expectedRevision: operation.revision,
      reason: 'seen in plugin operations',
    });
    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.outcomeCode).toBe('transport_failure');
    expect(acknowledged.acknowledgedReason).toBe('seen in plugin operations');
    // The journal keeps the original uncertain outcome but no longer holds new claims.
    expect(journal.inspectPending()).toHaveLength(0);
    // A brand-new invocation identity can now be claimed; the old record is untouched.
    const next = await call('attempt-2_plugin_call_1');
    expect(next.admitted).toBe(true);
    expect(counts.invoke).toBe(2);
    expect(operations.show(operation.id).state).toBe('acknowledged');
    expect(operations.list()).toHaveLength(2);
    expect(() =>
      operations.acknowledge({
        operationId: operation.id,
        expectedRevision: acknowledged.revision,
      }),
    ).toThrow(/operation_not_uncertain/);
  });

  it('lowers a crashed started row to uncertain on startup and keeps the hold', () => {
    const { db, journal, operations } = fixture();
    journal.claimNow(
      'attempt-1_plugin_call_1',
      'list_issues',
      { taskRunId: 'task_run_1', attemptId: 'attempt-1' },
      'fingerprint',
    );
    db.prepare(
      `INSERT INTO ocean_plugin_operations (id, task_run_id, attempt_id, workspace_id, room_id,
        bot_id, plugin_id, connection_id, connection_generation, endpoint, tool, repository,
        schema_digest, arguments_digest, arguments, state, outcome_code, detail, result_summary,
        result_bytes, truncated, revision, created_at, settled_at, acknowledged_at,
        acknowledged_reason)
       VALUES ('attempt-1_plugin_call_1','task_run_1','attempt-1','ws','room','bot_dev','github',
        'conn_work',1,'https://api.githubcopilot.com/mcp/','list_issues','team/api',?,?,'{}',
        'started',NULL,NULL,NULL,NULL,0,1,?,NULL,NULL,NULL)`,
    ).run('a'.repeat(64), 'b'.repeat(64), at);
    expect(operations.recover()).toEqual({ lowered: 1 });
    const recovered = operations.show('attempt-1_plugin_call_1');
    expect(recovered.state).toBe('uncertain');
    expect(recovered.outcomeCode).toBe('interrupted');
    expect(recovered.detail).toContain('restarted');
    expect(recovered.revision).toBe(2);
    expect(journal.inspectPending()).toHaveLength(1);
    expect(operations.recover()).toEqual({ lowered: 0 });
  });
});
