import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rig } from './model-process-rig.ts';
import type { LocalRoomModelPolicy } from '@runnets/contracts';
export async function policy() {
  const f = await rig();
  try {
    const owner = await f.launch();
    const a = await f.peer(),
      b = await f.peer();
    await a.client.setModelConnection({
      connectionId: 'policy-local',
      requestId: 'local',
      expectedRevision: null,
      providerId: 'ollama',
      kind: 'local',
      endpoint: 'http://127.0.0.1:11434',
      auth: 'none',
      defaultModelId: 'qwen3:1.7b',
    });
    assert.equal(
      (await a.client.checkModelConnection({ connectionId: 'policy-local' })).check.outcome,
      'ok',
    );
    const bots = [];
    for (const handle of ['policy-one', 'policy-two'])
      bots.push(
        await a.client.createBoundBot({
          workspaceId: 'ws_ocean',
          requestId: handle,
          handle,
          name: handle,
          role: 'Policy fixture',
          binding: { connectionId: 'policy-local', modelId: 'qwen3:1.7b' },
        }),
      );
    const room = await a.client.createGroup({
      workspaceId: 'ws_ocean',
      requestId: 'policy-group',
      title: 'Policy-only local group',
      botIds: bots.map((b) => b.bot.id),
    });
    const scope = { workspaceId: 'ws_ocean', roomId: room.data.id };
    const expected = (revision: number, cloudTransfer: 'allow' | 'deny'): LocalRoomModelPolicy => ({
      roomId: scope.roomId,
      revision,
      cloudTransfer,
    });
    const stored = () => {
      const db = new DatabaseSync(f.profile + '/runtime.sqlite', { readOnly: true });
      try {
        const row = db
          .prepare('SELECT * FROM ocean_room_model_policies WHERE room_id=?')
          .get(scope.roomId)!;
        return {
          roomId: row['room_id'],
          revision: row['revision'],
          cloudTransfer: row['cloud_transfer'],
        };
      } finally {
        db.close();
      }
    };
    const get = async (client: typeof a.client, wanted: LocalRoomModelPolicy) => {
      const db = new DatabaseSync(f.profile + '/runtime.sqlite', { readOnly: true });
      try {
        const before = JSON.stringify(
          db.prepare('SELECT * FROM ocean_room_model_policies ORDER BY room_id').all(),
        );
        const version = JSON.stringify(db.prepare('PRAGMA data_version').get());
        assert.deepEqual(stored(), wanted);
        const result = await client.getRoomModelPolicy(scope);
        assert.deepEqual(result, { version: 1, ...scope, policy: wanted });
        assert.equal(
          JSON.stringify(
            db.prepare('SELECT * FROM ocean_room_model_policies ORDER BY room_id').all(),
          ) === before,
          true,
          'policy get changed stored policy',
        );
        assert.equal(
          JSON.stringify(db.prepare('PRAGMA data_version').get()) === version,
          true,
          'policy get committed a database write',
        );
        return result;
      } finally {
        db.close();
      }
    };
    const baseline = await owner.snapshot();
    const initial = await get(a.client, expected(1, 'allow'));
    assert.deepEqual(await owner.snapshot(), baseline);
    const denied = await b.client.setRoomModelPolicy({
      ...scope,
      requestId: 'deny',
      expectedRevision: initial.policy.revision,
      cloudTransfer: 'deny',
    });
    assert.deepEqual(denied, expected(2, 'deny'));
    assert.deepEqual(stored(), expected(2, 'deny'));
    await assert.rejects(
      a.client.setRoomModelPolicy({
        ...scope,
        requestId: 'stale',
        expectedRevision: 1,
        cloudTransfer: 'allow',
      }),
      /model_policy_revision_conflict/,
    );
    await get(a.client, expected(2, 'deny'));
    await owner.kill();
    await a.kill();
    await b.kill();
    const successor = await f.launch(),
      fresh = await f.peer();
    const restarted = await successor.snapshot();
    const refreshed = await get(fresh.client, expected(2, 'deny'));
    assert.deepEqual(await successor.snapshot(), restarted);
    const allowed = await fresh.client.setRoomModelPolicy({
      ...scope,
      requestId: 'allow',
      expectedRevision: refreshed.policy.revision,
      cloudTransfer: 'allow',
    });
    assert.deepEqual(allowed, expected(3, 'allow'));
    assert.deepEqual(stored(), expected(3, 'allow'));
    const after = await successor.snapshot();
    await get(fresh.client, expected(3, 'allow'));
    assert.deepEqual(await successor.snapshot(), after);
    return {
      values: ['allow', 'deny', 'allow'],
      revisions: [1, 2, 3],
      localMetadataRequests: baseline.counters.probe,
      inferenceRequests: baseline.counters.dispatch,
      readWrites: 0,
    };
  } finally {
    await f.close();
  }
}
