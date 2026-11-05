import assert from 'node:assert/strict';
import { rig, setInput } from './model-process-rig.ts';
import { activeWitness } from './model-process-witness.ts';
export async function lostReply() {
  const f = await rig();
  try {
    const owner = await f.launch();
    const a = await f.peer();
    const baseline = await owner.snapshot();
    await owner.call('drop', { method: 'modelConnections.set', requestId: setInput.requestId });
    await assert.rejects(a.client.setModelConnection(setInput), /^Error: connection_closed$/);
    const committed = activeWitness(f.profile, setInput.requestId);
    const snapshot = await owner.snapshot();
    assert.ok(snapshot.phases.includes('reply-suppressed-after-active-receipt'));
    assert.equal(snapshot.counters.published - baseline.counters.published, 1);
    const b = await f.peer();
    const receipt = await b.client.setModelConnection(setInput);
    assert.equal(
      JSON.stringify(activeWitness(f.profile, setInput.requestId)) === JSON.stringify(committed),
      true,
      'stored receipt bytes changed',
    );
    assert.deepEqual(await owner.snapshot(), snapshot);
    await owner.kill();
    const next = await f.launch();
    assert.notEqual(next.info.identity.instanceId, owner.info.identity.instanceId);
    const c = await f.peer(),
      d = await f.peer();
    const restarted = await next.snapshot();
    assert.equal(restarted.counters.attempt, 0);
    assert.deepEqual(await c.client.setModelConnection(setInput), receipt);
    const replays = await Promise.all([
      c.client.setModelConnection(setInput),
      d.client.setModelConnection(setInput),
    ]);
    assert.deepEqual(replays, [receipt, receipt]);
    for (const changed of [
      { key: 'synthetic-wrong-key' },
      { defaultModelId: 'deepseek-v4-pro' },
      { expectedRevision: 1 },
    ])
      await assert.rejects(
        c.client.setModelConnection({ ...setInput, ...changed }),
        /request_conflict/,
      );
    assert.equal(
      JSON.stringify(activeWitness(f.profile, setInput.requestId)) === JSON.stringify(committed),
      true,
      'stored receipt bytes changed',
    );
    assert.deepEqual(await next.snapshot(), restarted);
    return {
      suppressed: 1,
      replays: 4,
      postRestartEffects: (await next.snapshot()).counters,
      ownerPids: [owner.info.pid, next.info.pid],
      entries: { host: next.info.host, sdk: next.info.sdk, store: next.info.store },
    };
  } finally {
    await f.close();
  }
}
