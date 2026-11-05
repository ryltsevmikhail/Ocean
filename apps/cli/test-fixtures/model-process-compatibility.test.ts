import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rig, setInput, until } from './model-process-rig.ts';
import { settingsWitness } from './model-process-witness.ts';
import { LOCAL_MODEL_METHODS } from '@runnets/contracts';
import type { LocalRuntimeStatus } from '@runnets/contracts';
export async function compatibility() {
  const f = await rig();
  try {
    const owner = await f.launch();
    const sdk = await f.peer(),
      rc2 = await f.peer('rc2'),
      a3 = await f.peer('a3');
    const modelOnly = await f.peer('model'),
      unknown = await f.peer('unknown');
    const expected = [
      [rc2, 45],
      [a3, 65],
      [sdk, 66],
      [modelOnly, 46],
      [unknown, 45],
    ] as const;
    for (let wave = 0; wave < 2; wave++) {
      const baseline = await owner.snapshot();
      const canonical = settingsWitness(f.profile);
      for (const old of [rc2, a3, unknown]) {
        await assert.rejects(
          old.raw('modelConnections.set', setInput),
          /model_runtime_upgrade_required/,
        );
        for (const method of LOCAL_MODEL_METHODS)
          await assert.rejects(old.raw(method), /model_runtime_upgrade_required/);
      }
      for (const old of [rc2, modelOnly, unknown])
        await assert.rejects(old.raw('plugin.catalog'), /plugin_runtime_upgrade_required/);
      assert.ok(Array.isArray(await a3.raw('plugin.catalog')));
      assert.ok(Array.isArray(await sdk.client.pluginCatalog()));
      assert.equal((await sdk.client.listModelConnections()).version, 1);
      assert.equal((await modelOnly.raw<{ version: number }>('modelConnections.list')).version, 1);
      assert.deepEqual(await owner.snapshot(), baseline);
      assert.equal(
        settingsWitness(f.profile) === canonical,
        true,
        'refused legacy command mutated canonical settings',
      );
      for (const [peer, size] of wave ? [...expected].reverse() : expected) {
        const status: LocalRuntimeStatus = await peer.client.status();
        assert.equal(status.capabilities.length, size);
        assert.equal(
          status.capabilities.includes('model.connections-v1'),
          peer === sdk || peer === modelOnly,
        );
        assert.equal(
          status.capabilities.includes('plugin.session-authority-v1'),
          peer === sdk || peer === a3,
        );
      }
      await assert.rejects(rc2.raw('future.fixture'), /method_not_found/);
    }
    await sdk.client.setModelConnection(setInput);
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
    const reconnected = await f.peer('a3');
    assert.equal((await reconnected.client.status()).capabilities.length, 65);
    assert.equal((await sdk.client.status()).capabilities.length, 66);
    assert.equal((await rc2.client.status()).capabilities.length, 45);
    await assert.rejects(
      reconnected.raw('modelConnections.set', { ...setInput, requestId: 'refused' }),
      /model_runtime_upgrade_required/,
    );
    assert.equal(
      (await sdk.client.listModelConnections()).items.filter((r) => r.connectionId === 'named')
        .length,
      1,
    );
    return {
      clientPids: [rc2.info.pid, reconnected.info.pid, sdk.info.pid],
      physicalEvents: physical.length,
      pages: Math.ceil(physical.length / 2),
      owner: owner.info.host,
    };
  } finally {
    await f.close();
  }
}
