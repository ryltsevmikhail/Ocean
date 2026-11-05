import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rig, setInput, until } from './model-process-rig.ts';
import type { LocalRunModelExecution } from '@runnets/contracts';
export function journal(profile: string, runId: string, view: LocalRunModelExecution) {
  const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT sequence,type,payload FROM events WHERE aggregate_id=? ORDER BY sequence')
      .all(runId);
    assert.equal(view.runVersion, rows.at(-1)!['sequence']);
    const starts = rows.filter((r) => r['type'] === 'attempt.model_request_started');
    const settlements = rows.filter((r) => r['type'] === 'attempt.model_request_settled');
    assert.equal(view.execution!.startedRequests, starts.length);
    assert.equal(view.execution!.usage.requestCounts!.pending, starts.length - settlements.length);
    const kinds = settlements.map(
      (r) => (JSON.parse(String(r['payload'])) as { usage: { kind: string } }).usage.kind,
    );
    for (const kind of ['actual', 'estimated', 'unavailable'] as const)
      assert.equal(
        view.execution!.usage.requestCounts![kind],
        kinds.filter((k) => k === kind).length,
      );
    const create = JSON.parse(String(rows[0]!['payload'])) as { workspaceId: string };
    assert.equal(create.workspaceId, 'ws_ws_ocean');
    return rows.length;
  } finally {
    db.close();
  }
}
export async function execution() {
  const f = await rig();
  try {
    const owner = await f.launch();
    const a = await f.peer(),
      b = await f.peer();
    await a.client.setModelConnection(setInput);
    assert.equal(
      (await a.client.checkModelConnection({ connectionId: 'named' })).check.outcome,
      'ok',
    );
    const bot = await a.client.createBoundBot({
      workspaceId: 'ws_ocean',
      requestId: 'bound',
      handle: 'bound',
      name: 'Bound',
      role: 'Fixture',
      binding: { connectionId: 'named', modelId: 'deepseek-flash' },
    });
    const room = await a.client.openDirect({
      workspaceId: 'ws_ocean',
      requestId: 'direct-bound',
      botId: bot.bot.id,
    });
    const scope = { workspaceId: 'ws_ocean', roomId: room.data.id };
    await owner.call('hold');
    const receipt = await a.client.submit({ ...scope, requestId: 'turn', text: 'synthetic' });
    const query = { ...scope, runId: receipt.runId! };
    await until(
      () => owner.snapshot(),
      (s) => s.counters.dispatch === 1,
    );
    const pending = await b.client.getRunModelExecution(query);
    const identity = {
      source: 'connection',
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      connectionId: 'named',
      connectionRevision: 1,
      botProfileVersion: 1,
      kind: 'cloud',
    };
    assert.deepEqual(pending.execution!.identity, identity);
    assert.deepEqual(pending.execution!.usage.requestCounts, {
      actual: 0,
      estimated: 0,
      unavailable: 0,
      pending: 1,
    });
    assert.equal(pending.execution!.lastRequest.settlement, null);
    const pendingVersion = journal(f.profile, query.runId, pending);
    await owner.call('release');
    await until(
      () => a.client.getRun(query),
      (r) => r?.turnStatus === 'completed',
    );
    const completed = await b.client.getRunModelExecution(query);
    assert.deepEqual(completed.execution!.identity, identity);
    assert.deepEqual(completed.execution!.usage.requestCounts, {
      actual: 1,
      estimated: 0,
      unavailable: 0,
      pending: 0,
    });
    assert.equal(completed.execution!.usage.knownTokens, 0);
    assert.equal(completed.execution!.usage.completeness, 'complete');
    assert.deepEqual(completed.execution!.lastRequest.settlement!.usage, {
      kind: 'actual',
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const completedVersion = journal(f.profile, query.runId, completed);
    assert.ok(completedVersion > pendingVersion);
    const fresh = await f.peer();
    assert.deepEqual(await fresh.client.getRunModelExecution(query), completed);
    await assert.rejects(
      fresh.client.getRunModelExecution({ ...query, workspaceId: 'foreign' }),
      /unknown_run/,
    );
    await assert.rejects(
      fresh.client.getRunModelExecution({ ...query, roomId: f.scope.roomId }),
      /unknown_run/,
    );
    await assert.rejects(
      fresh.client.getRunModelExecution({ ...query, runId: 'foreign' }),
      /unknown_run/,
    );
    await a.client.setBotModelBinding({
      workspaceId: 'ws_ocean',
      requestId: 'rebind',
      botId: bot.bot.id,
      expectedProfileVersion: 1,
      binding: { connectionId: 'named', modelId: 'deepseek-v4-pro' },
    });
    await a.client.setModelConnection({
      ...setInput,
      requestId: 'rotate',
      expectedRevision: 1,
      defaultModelId: 'deepseek-v4-pro',
      key: 'synthetic-rotation-key',
    });
    assert.deepEqual(await b.client.getRunModelExecution(query), completed);
    await owner.kill();
    const successor = await f.launch();
    const last = await f.peer();
    const baseline = await successor.snapshot();
    assert.deepEqual(await last.client.getRunModelExecution(query), completed);
    assert.deepEqual(await successor.snapshot(), baseline);
    return {
      pendingVersion,
      completedVersion,
      requests: completed.execution!.usage.requestCounts,
      knownTokens: 0,
      historicalIdentityPreserved: true,
      owner: successor.info.host,
    };
  } finally {
    await f.close();
  }
}
