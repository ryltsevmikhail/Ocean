import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rig, setInput } from './model-process-rig.ts';
import { activeWitness, publicReceipt, receiptOwner } from './model-process-witness.ts';
export async function lostReply() {
  const f = await rig();
  try {
    const owner = await f.launch(true);
    const receiptFamily = receiptOwner('modelConnections.set', setInput.connectionId);
    const a = await f.peer();
    const baseline = await owner.snapshot();
    await owner.call('drop', {
      method: 'modelConnections.set',
      requestId: setInput.requestId,
      connectionId: setInput.connectionId,
    });
    await assert.rejects(a.client.setModelConnection(setInput), /^Error: connection_closed$/);
    // Immutable serialized copy of the actual suppressed response, not a later database value.
    const capturedOriginal = readFileSync(f.profile + '/suppressed-public-result.json', 'utf8');
    const committed = activeWitness(f.profile, setInput.requestId, receiptFamily);
    assert.equal(
      JSON.stringify(publicReceipt(committed, receiptFamily)) === capturedOriginal,
      true,
      'post-close public result differs from captured suppressed original',
    );
    const verifyStored = () => {
      const current = activeWitness(f.profile, setInput.requestId, receiptFamily);
      assert.equal(
        JSON.stringify(publicReceipt(current, receiptFamily)) === capturedOriginal,
        true,
        'stored public result differs from captured suppressed original',
      );
      assert.equal(
        JSON.stringify(current) === JSON.stringify(committed),
        true,
        'stored receipt bytes changed',
      );
    };
    const snapshot = await owner.snapshot();
    assert.ok(snapshot.phases.includes('reply-suppressed-after-active-receipt'));
    assert.equal(snapshot.counters.published - baseline.counters.published, 1);
    const b = await f.peer();
    assert.equal(
      JSON.stringify(await b.client.setModelConnection(setInput)) === capturedOriginal,
      true,
      'first replay differs from original persisted/suppressed public result',
    );
    verifyStored();
    assert.deepEqual(await owner.snapshot(), snapshot);
    await owner.kill();
    const next = await f.launch();
    assert.notEqual(next.info.identity.instanceId, owner.info.identity.instanceId);
    const c = await f.peer(),
      d = await f.peer();
    const restarted = await next.snapshot();
    assert.equal(restarted.counters.attempt, 0);
    assert.equal(
      JSON.stringify(await c.client.setModelConnection(setInput)) === capturedOriginal,
      true,
      'restart replay differs from original public result',
    );
    const replays = await Promise.all([
      c.client.setModelConnection(setInput),
      d.client.setModelConnection(setInput),
    ]);
    assert.equal(
      replays.every((r) => JSON.stringify(r) === capturedOriginal),
      true,
      'concurrent replay differs from original public result',
    );
    for (const changed of [
      { key: 'synthetic-wrong-key' },
      { defaultModelId: 'deepseek-v4-pro' },
      { expectedRevision: 1 },
    ])
      await assert.rejects(
        c.client.setModelConnection({ ...setInput, ...changed }),
        /request_conflict/,
      );
    verifyStored();
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
