import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rig, until } from './model-process-rig.ts';
import { negotiationWaves } from './model-process-negotiation.ts';
export async function compatibility() {
  const f = await rig();
  try {
    const owner = await f.launch();
    const sdk = await f.peer(),
      rc2 = await f.peer('rc2');
    let a3 = await f.peer('a3');
    const modelOnly = await f.peer('model'),
      unknown = await f.peer('unknown');
    const before = await negotiationWaves(
      f,
      owner,
      { sdk, rc2, a3, modelOnly, unknown },
      0,
      'before',
    );
    await sdk.client.setBotModelBinding({
      workspaceId: 'ws_ocean',
      requestId: 'bind',
      botId: f.seed.botId,
      expectedProfileVersion: 1,
      binding: { connectionId: 'named', modelId: 'deepseek-flash' },
    });
    const receipt = await sdk.client.submit({ ...f.scope, requestId: 'turn', text: 'synthetic' });
    const query = { ...f.scope, runId: receipt.runId! };
    await until(
      () => sdk.client.getRun(query),
      (r) => r?.turnStatus === 'completed',
    );
    const db = new DatabaseSync(f.profile + '/runtime.sqlite', { readOnly: true });
    let physical: { sequence: number; type: string }[];
    try {
      physical = db
        .prepare('SELECT sequence,type FROM events WHERE aggregate_id=? ORDER BY sequence')
        .all(receipt.runId!) as unknown as typeof physical;
    } finally {
      db.close();
    }
    assert.ok(physical.some((e) => e.type === 'attempt.model_request_started'));
    assert.ok(physical.some((e) => e.type === 'attempt.model_request_settled'));
    for (const old of [rc2, a3]) {
      const seen: { sequence: number; type: string; sensitivity?: string }[] = [];
      let after = 0;
      while (true) {
        const pageQuery = { ...query, after, limit: 2 };
        const events = await old.client.listEvents(pageQuery);
        const wire = await old.raw<{ events: unknown[] }>('runs.events', pageQuery);
        assert.deepEqual(Object.keys(wire).sort(), ['events', 'roomId', 'runId', 'workspaceId']);
        assert.deepEqual(wire.events, events);
        if (!events.length) break;
        seen.push(...events);
        after = events.at(-1)!.sequence;
      }
      assert.deepEqual(
        seen.map((e) => e.sequence),
        physical.map((e) => e.sequence),
      );
      for (const event of physical)
        if (event.type.startsWith('attempt.model_request'))
          assert.deepEqual(seen[event.sequence - 1], {
            sequence: event.sequence,
            type: 'redacted',
            sensitivity: 'restricted',
          });
    }
    await a3.kill();
    a3 = await f.peer('a3');
    const after = await negotiationWaves(
      f,
      owner,
      { sdk, rc2, a3, modelOnly, unknown },
      before.revision,
      'after',
    );
    assert.deepEqual(after.orders, before.orders);
    return {
      clientPids: [rc2.info.pid, a3.info.pid, sdk.info.pid],
      physicalEvents: physical.length,
      mutationOrders: [before.orders, after.orders],
      permittedMutations: after.revision,
      pages: Math.ceil(physical.length / 2),
      owner: owner.info.host,
    };
  } finally {
    await f.close();
  }
}
