import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rig, until } from './model-process-rig.ts';
import { descriptors, mixedSetup } from './model-mixed-setup.ts';
import type { MixedSnapshot } from './model-mixed-ports.ts';
import type { LocalTurnReceipt } from '@runnets/contracts';
export async function mixedRestart() {
  const f = await rig('mixed');
  try {
    const owner = await f.launch(),
      a = await f.peer(),
      observer = await f.peer();
    const m = await mixedSetup(a.client);
    const scope = { workspaceId: 'ws_ocean', roomId: m.rooms[1]! };
    const input = { ...scope, requestId: 'lost-turn', text: 'frozen request' };
    await owner.call('hold');
    await owner.call('dropTurn', input.requestId);
    await assert.rejects(a.client.submit(input), /connection_closed/);
    const receiptBytes = readFileSync(f.profile + '/lost-turn.json', 'utf8');
    const receipt = JSON.parse(receiptBytes) as LocalTurnReceipt;
    const query = { ...scope, runId: receipt.runId! };
    const before = await until(
      () => owner.call<MixedSnapshot>('mixedSnapshot'),
      (s) => s.requests.length === 1,
    );
    assert.equal(before.requests[0]!.credential, 'initial');
    const pending = await observer.client.getRunModelExecution(query);
    assert.equal(pending.execution!.lastRequest.settlement, null);
    await observer.client.setModelConnection({
      ...descriptors[1]!,
      expectedRevision: 1,
      requestId: 'rotate',
      key: 'synthetic-rotated',
    });
    await observer.client.setBotModelBinding({
      workspaceId: 'ws_ocean',
      requestId: 'rebind',
      botId: m.bots[1]!.bot.id,
      expectedProfileVersion: m.bots[1]!.bot.profileVersion,
      binding: m.bots[2]!.binding!,
    });
    await owner.call('release');
    await until(
      () => observer.client.getRun(query),
      (r) => r?.turnStatus === 'completed',
    );
    const completed = await observer.client.getRunModelExecution(query);
    assert.deepEqual(completed.execution!.identity, pending.execution!.identity);
    await owner.kill();
    await a.kill();
    await observer.kill();
    const next = await f.launch(),
      fresh = await f.peer();
    assert.notEqual(next.info.pid, owner.info.pid);
    assert.notEqual(next.info.identity.instanceId, owner.info.identity.instanceId);
    const baseline = await next.call<MixedSnapshot>('mixedSnapshot');
    assert.equal(
      JSON.stringify(await fresh.client.submit(input)) === receiptBytes,
      true,
      'historical lost receipt changed',
    );
    assert.deepEqual(await fresh.client.getRunModelExecution(query), completed);
    assert.deepEqual(await next.call('mixedSnapshot'), baseline);
    const changed = await fresh.client.submit({ ...input, requestId: 'rebound-turn' });
    await until(
      () => fresh.client.getRun({ ...scope, runId: changed.runId! }),
      (r) => r?.turnStatus === 'completed',
    );
    assert.equal(
      (await next.call<MixedSnapshot>('mixedSnapshot')).requests[0]!.origin,
      'https://api.anthropic.com',
    );
    await fresh.client.setBotModelBinding({
      workspaceId: 'ws_ocean',
      requestId: 'rebind-back',
      botId: m.bots[1]!.bot.id,
      expectedProfileVersion: m.bots[1]!.bot.profileVersion + 1,
      binding: m.bots[1]!.binding!,
    });
    const rotated = await fresh.client.submit({ ...input, requestId: 'rotated-turn' });
    await until(
      () => fresh.client.getRun({ ...scope, runId: rotated.runId! }),
      (r) => r?.turnStatus === 'completed',
    );
    const requests = (await next.call<MixedSnapshot>('mixedSnapshot')).requests;
    assert.deepEqual(
      requests.map((r) => [r.origin, r.credential]),
      [
        ['https://api.anthropic.com', 'initial'],
        ['https://api.openai.com', 'rotated'],
      ],
    );
    await next.call('hold');
    const pendingInput = { ...input, requestId: 'kill-after-start' };
    const started = await fresh.client.submit(pendingInput);
    const startedQuery = { ...scope, runId: started.runId! };
    await until(
      () => next.call<MixedSnapshot>('mixedSnapshot'),
      (s) => s.requests.length === 3,
    );
    const startedView = await fresh.client.getRunModelExecution(startedQuery);
    assert.equal(startedView.execution!.lastRequest.settlement, null);
    assert.equal(startedView.execution!.usage.requestCounts!.pending, 1);
    await next.kill();
    await fresh.kill();
    const last = await f.launch(),
      client = await f.peer();
    assert.deepEqual(await client.client.submit(pendingInput), started);
    const held = await client.client.getRun(startedQuery);
    assert.equal(held!.turnStatus, 'uncertain');
    assert.equal(held!.taskStatus, 'reconciling');
    assert.equal(
      (await client.client.getRunModelExecution(startedQuery)).execution!.lastRequest.settlement,
      null,
    );
    assert.equal((await last.call<MixedSnapshot>('mixedSnapshot')).requests.length, 0);
    await assert.rejects(
      client.client.submit({ ...input, requestId: 'held-new' }),
      /recovery_required/,
    );
    return {
      ownerPids: [owner.info.pid, next.info.pid, last.info.pid],
      lostReceiptExact: true,
      originalRequests: before.requests.length,
      rotatedRequests: requests,
      redispatchAfterKill: 0,
      confirmedCancellation: false,
    };
  } finally {
    await f.close();
  }
}
