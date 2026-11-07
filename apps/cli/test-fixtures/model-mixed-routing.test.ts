import assert from 'node:assert/strict';
import { rig, until } from './model-process-rig.ts';
import { mixedSetup } from './model-mixed-setup.ts';
import { journal } from './model-process-execution.test.ts';
import type { MixedSnapshot } from './model-mixed-ports.ts';
export async function mixedRouting() {
  const f = await rig('mixed');
  try {
    const owner = await f.launch(),
      a = await f.peer(),
      old = await f.peer('rc2');
    const m = await mixedSetup(a.client);
    const snapshot = () => owner.call<MixedSnapshot>('mixedSnapshot');
    await owner.call('mode', 'drift');
    for (const roomId of [m.rooms[0]!, m.scope.roomId]) {
      const receipt = await a.client.submit({
        workspaceId: 'ws_ocean',
        roomId,
        requestId: 'failed-' + roomId,
        text: '@' + m.bots[0]!.bot.handle + ' hello',
      });
      const query = { workspaceId: 'ws_ocean', roomId, runId: receipt.runId! };
      const run = await until(
        () => a.client.getRun(query),
        (r) => r?.turnStatus === 'failed',
      );
      assert.equal(run!.taskStatus, 'failed');
      assert.equal(await a.client.getResult(query), null);
      const view = await a.client.getRunModelExecution(query);
      assert.equal(view.execution!.lastRequest.settlement!.completion.kind, 'not_sent');
      assert.equal(view.execution!.lastRequest.settlement!.usage.kind, 'unavailable');
      journal(f.profile, query.runId, view);
    }
    assert.equal((await snapshot()).requests.length, 0, 'unaddressed cloud siblings must not run');
    const groupCloud = await a.client.submit({
      ...m.scope,
      requestId: 'group-cloud',
      text: '@' + m.bots[1]!.bot.handle + ' hello',
    });
    await until(
      () => a.client.getRun({ ...m.scope, runId: groupCloud.runId! }),
      (r) => {
        if (r?.turnStatus === 'uncertain') throw Error('unexpected uncertain:' + JSON.stringify(r));
        return r?.turnStatus === 'completed';
      },
    );
    assert.equal((await snapshot()).requests.length, 1);
    const batch = await a.client.broadcastSubmit({
      ...m.scope,
      requestId: 'broadcast',
      text: 'hello all',
    });
    const done = await until(
      () => a.client.broadcastGet({ ...m.scope, batchId: batch.id }),
      (b) => b.state === 'completed',
    );
    assert.deepEqual(
      done.recipients.map((r) => [r.handle, r.state]),
      m.bots.map((b, index) => [b.bot.handle, index === 0 ? 'refused' : 'answered']),
    );
    assert.equal(
      (await snapshot()).requests.length,
      3,
      'cloud requests belong only to independently addressed children',
    );
    await owner.call('mode', 'normal');
    for (const [index, roomId] of m.rooms.entries()) {
      const scope = { workspaceId: 'ws_ocean', roomId };
      const receipt = await a.client.submit({
        ...scope,
        requestId: 'ordinary-' + index,
        text: 'hello',
      });
      const query = { ...scope, runId: receipt.runId! };
      await until(
        () => a.client.getRun(query),
        (r) => {
          if (r?.turnStatus === 'uncertain')
            throw Error('unexpected uncertain:' + JSON.stringify(r));
          return r?.turnStatus === 'completed';
        },
      );
      const execution = await a.client.getRunModelExecution(query);
      assert.equal(execution.execution!.lastRequest.settlement!.completion.kind, 'terminal');
      if (index === 0) assert.equal(execution.execution!.usage.completeness, 'incomplete');
      assert.ok(
        (await old.client.listRooms({ workspaceId: 'ws_ocean' })).some((r) => r.id === roomId),
      );
      assert.equal((await old.client.listMembers(scope))[0]!.provider, m.bots[index]!.bot.provider);
      assert.equal((await old.client.history(scope)).at(-1)!.author, 'bot');
      assert.equal(
        (await old.client.listRuns(scope)).find((r) => r.runId === query.runId)!.turnStatus,
        'completed',
      );
      assert.equal((await old.client.getResult(query))!.author, 'bot');
    }
    const profiles = await old.client.listBots({ workspaceId: 'ws_ocean' });
    for (const bot of m.bots)
      assert.ok(
        profiles.some(
          (p) =>
            p.id === bot.bot.id && p.provider === bot.bot.provider && p.model === bot.bot.model,
        ),
      );
    const result = await snapshot();
    assert.equal(result.origins['http://127.0.0.1:11434']!.inference, 1);
    assert.equal(result.origins['https://api.openai.com']!.inference, 3);
    assert.equal(result.origins['https://api.anthropic.com']!.inference, 2);
    return { ...result, ordinaryFrozenDecoders: 3, source: owner.info.host };
  } finally {
    await f.close();
  }
}
