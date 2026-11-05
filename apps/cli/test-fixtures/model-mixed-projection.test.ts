import assert from 'node:assert/strict';
import { rig, until } from './model-process-rig.ts';
import { mixedSetup } from './model-mixed-setup.ts';
import type { MixedSnapshot } from './model-mixed-ports.ts';
export async function mixedProjection() {
  const f = await rig('mixed');
  try {
    const first = await f.launch(),
      a = await f.peer();
    const m = await mixedSetup(a.client);
    const scope = { workspaceId: 'ws_ocean', roomId: m.rooms[0]! };
    const input = { ...scope, requestId: 'crash-gap', text: 'preflight failure' };
    await first.call('mode', 'drift');
    await first.call('crashGap');
    const receipt = await a.client.submit(input);
    const query = { ...scope, runId: receipt.runId! };
    const gap = await until(
      () => a.client.getRun(query),
      (r) => r?.taskStatus === 'failed',
    );
    assert.equal(gap!.turnStatus, 'dispatching');
    assert.equal(
      (await a.client.getRunModelExecution(query)).execution!.lastRequest.settlement!.completion
        .kind,
      'not_sent',
    );
    assert.equal((await first.call<MixedSnapshot>('mixedSnapshot')).requests.length, 0);
    await first.kill();
    await a.kill();
    const second = await f.launch(),
      b = await f.peer();
    assert.notEqual(first.info.pid, second.info.pid);
    assert.equal((await b.client.getRun(query))!.turnStatus, 'failed');
    assert.deepEqual(await b.client.submit(input), receipt);
    assert.equal((await second.call<MixedSnapshot>('mixedSnapshot')).requests.length, 0);
    await second.call('mode', 'lost');
    const unknownInput = { ...input, requestId: 'sent-lost' };
    const unknown = await b.client.submit(unknownInput);
    const unknownQuery = { ...scope, runId: unknown.runId! };
    const held = await until(
      () => b.client.getRun(unknownQuery),
      (r) => r?.turnStatus === 'uncertain',
    );
    assert.equal(held!.taskStatus, 'reconciling');
    const execution = await b.client.getRunModelExecution(unknownQuery);
    assert.equal(execution.execution!.lastRequest.settlement!.completion.kind, 'unknown');
    assert.equal(execution.execution!.lastRequest.settlement!.usage.kind, 'unavailable');
    assert.equal(
      (await second.call<MixedSnapshot>('mixedSnapshot')).origins['http://127.0.0.1:11434']!
        .inference,
      1,
    );
    await second.kill();
    await b.kill();
    const third = await f.launch(),
      c = await f.peer();
    assert.deepEqual(await c.client.submit(unknownInput), unknown);
    assert.equal((await c.client.getRun(unknownQuery))!.turnStatus, 'uncertain');
    await assert.rejects(
      c.client.submit({ ...input, requestId: 'no-unknown-retry' }),
      /recovery_required/,
    );
    const cloudScope = { workspaceId: 'ws_ocean', roomId: m.rooms[1]! };
    const cloud = await c.client.submit({
      ...cloudScope,
      requestId: 'separate-cloud',
      text: 'own request',
    });
    await until(
      () => c.client.getRun({ ...cloudScope, runId: cloud.runId! }),
      (r) => r?.turnStatus === 'completed',
    );
    const snapshot = await third.call<MixedSnapshot>('mixedSnapshot');
    assert.equal(snapshot.requests.length, 1);
    assert.equal(snapshot.requests[0]!.origin, 'https://api.openai.com');
    const localBot = await c.client.createBoundBot({
      workspaceId: 'ws_ocean',
      requestId: 'before-fail-bot',
      handle: 'before-fail',
      name: 'Before Fail',
      role: 'Fixture',
      binding: m.bots[0]!.binding!,
    });
    const localRoom = await c.client.openDirect({
      workspaceId: 'ws_ocean',
      requestId: 'before-fail-room',
      botId: localBot.bot.id,
    });
    const beforeInput = {
      workspaceId: 'ws_ocean',
      roomId: localRoom.data.id,
      requestId: 'before-fail-turn',
      text: 'not_sent is not a failed task',
    };
    await third.call('mode', 'drift');
    await third.call('beforeFail');
    const beforeReceipt = await c.client.submit(beforeInput);
    const beforeQuery = {
      workspaceId: beforeInput.workspaceId,
      roomId: beforeInput.roomId,
      runId: beforeReceipt.runId!,
    };
    await until(
      () => c.client.getRunModelExecution(beforeQuery),
      (v) => v.execution?.lastRequest.settlement?.completion.kind === 'not_sent',
    );
    assert.equal((await c.client.getRun(beforeQuery))!.taskStatus, 'running');
    await third.kill();
    await c.kill();
    const fourth = await f.launch(),
      d = await f.peer();
    assert.deepEqual(await d.client.submit(beforeInput), beforeReceipt);
    assert.equal((await d.client.getRun(beforeQuery))!.turnStatus, 'uncertain');
    assert.equal((await d.client.getRun(beforeQuery))!.taskStatus, 'reconciling');
    assert.equal((await fourth.call<MixedSnapshot>('mixedSnapshot')).requests.length, 0);
    return {
      ownerPids: [first.info.pid, second.info.pid, third.info.pid, fourth.info.pid],
      knownPreflightInference: 0,
      unknownInference: 1,
      unknownRedispatch: 0,
      independentlyAddressedCloud: 1,
      notSentBeforeFailRemainsHeld: true,
      confirmedCancellation: false,
    };
  } finally {
    await f.close();
  }
}
