import assert from 'node:assert/strict';
import { rig, setInput } from './model-process-rig.ts';
import type { LocalBoundBot, LocalModelConnectionMetadata } from '@runnets/contracts';
export async function metadata() {
  const f = await rig();
  try {
    const owner = await f.launch();
    const a = await f.peer(),
      b = await f.peer();
    const ids = Array.from({ length: 51 }, (_, i) => 'c-' + String(i).padStart(3, '0'));
    for (const id of [...ids].reverse())
      await a.client.setModelConnection({ ...setInput, connectionId: id, requestId: id });
    await a.client.disconnectModelConnection({
      connectionId: ids[0]!,
      requestId: 'disconnect',
      expectedRevision: 1,
    });
    await owner.call('fault', {
      requestId: 'pending',
      timing: 'before',
      owner: { family: 'model', connectionId: ids[25]! },
    });
    await assert.rejects(
      a.client.setModelConnection({
        ...setInput,
        connectionId: ids[25]!,
        requestId: 'pending',
        expectedRevision: 1,
      }),
      /provider_write_failed/,
    );
    const bots: LocalBoundBot[] = [];
    for (let i = 50; i >= 0; i--)
      bots.push(
        await a.client.createBoundBot({
          workspaceId: 'ws_ocean',
          requestId: 'bot-' + i,
          handle: 'b' + i,
          name: 'Bot ' + i,
          role: 'Fixture',
          binding: { connectionId: ids[i]!, modelId: i % 2 ? 'deepseek-v4-pro' : 'deepseek-flash' },
        }),
      );
    const legacyBot: LocalBoundBot = {
      bot: {
        id: f.seed.botId,
        workspaceId: 'ws_ocean',
        handle: 'dev',
        name: 'Dev',
        role: 'Fixture',
        provider: 'deepseek',
        model: 'deepseek-flash',
        profileVersion: 1,
      },
      binding: { connectionId: 'legacy:deepseek', modelId: 'deepseek-flash' },
    };
    const expectedBots = [...bots, legacyBot].sort((a, b) => a.bot.id.localeCompare(b.bot.id));
    const readPages = async (client: typeof a.client) => {
      const first = await client.listModelConnections();
      assert.equal(first.items.length, 50);
      assert.equal(first.nextAfter, ids[49]);
      const rest = await client.listModelConnections({ after: first.nextAfter! });
      assert.deepEqual(
        [...first.items, ...rest.items].map((r) => r.connectionId),
        [...ids, 'legacy:deepseek'],
      );
      const connections: LocalModelConnectionMetadata[] = [];
      let after: string | undefined;
      do {
        const page = await client.listModelConnections({ limit: 2, ...(after ? { after } : {}) });
        connections.push(...page.items);
        if (page.nextAfter) assert.equal(page.nextAfter, page.items.at(-1)!.connectionId);
        after = page.nextAfter ?? undefined;
      } while (after);
      assert.deepEqual(connections, [...first.items, ...rest.items]);
      assert.equal((await client.listModelConnections({ limit: 200 })).items.length, 52);
      assert.equal(connections[0]!.configuration?.intent, 'disconnected');
      assert.equal(connections[25]!.recovery?.kind, 'retry_available');
      assert.equal(connections[2]!.configuration?.intent, 'active');
      const defaultBots = await client.listBoundBots({ workspaceId: 'ws_ocean' });
      assert.equal(defaultBots.items.length, 50);
      const tail = await client.listBoundBots({
        workspaceId: 'ws_ocean',
        after: defaultBots.nextAfter!,
      });
      assert.deepEqual([...defaultBots.items, ...tail.items], expectedBots);
      const small: LocalBoundBot[] = [];
      after = undefined;
      do {
        const page = await client.listBoundBots({
          workspaceId: 'ws_ocean',
          limit: 2,
          ...(after ? { after } : {}),
        });
        small.push(...page.items);
        if (page.nextAfter) assert.equal(page.nextAfter, page.items.at(-1)!.bot.id);
        after = page.nextAfter ?? undefined;
      } while (after);
      assert.deepEqual(small, expectedBots);
      assert.equal(
        (await client.listBoundBots({ workspaceId: 'ws_ocean', limit: 200 })).items.length,
        52,
      );
      assert.deepEqual((await client.listBoundBots(f.scope)).items, [legacyBot]);
      await assert.rejects(client.listBoundBots({ ...f.scope, roomId: 'foreign' }), /unknown_room/);
      await assert.rejects(client.listBoundBots({ workspaceId: 'foreign' }), /workspace_conflict/);
      await assert.rejects(
        client.listModelConnections({ workspaceId: 'foreign' }),
        /workspace_conflict/,
      );
    };
    const baseline = await owner.snapshot();
    await readPages(b.client);
    await readPages(a.client);
    assert.deepEqual(await owner.snapshot(), baseline);
    const selected = bots[0]!;
    const changed = await b.client.setBotModelBinding({
      workspaceId: 'ws_ocean',
      botId: selected.bot.id,
      requestId: 'rebind',
      expectedProfileVersion: 1,
      binding: { connectionId: ids[1]!, modelId: 'deepseek-v4-pro' },
    });
    assert.equal(changed.bot.profileVersion, 2);
    expectedBots[expectedBots.findIndex((r) => r.bot.id === changed.bot.id)] = changed;
    await assert.rejects(
      a.client.setBotModelBinding({
        workspaceId: 'ws_ocean',
        botId: selected.bot.id,
        requestId: 'stale',
        expectedProfileVersion: 1,
        binding: selected.binding!,
      }),
      /bot_profile_version_conflict/,
    );
    await a.client.setModelConnection({
      ...setInput,
      connectionId: ids[1]!,
      requestId: 'change-default',
      expectedRevision: 1,
      defaultModelId: 'deepseek-flash',
    });
    await a.client.disconnectModelConnection({
      connectionId: ids[1]!,
      requestId: 'disconnect-bound',
      expectedRevision: 2,
    });
    await owner.kill();
    await a.kill();
    await b.kill();
    const next = await f.launch();
    const fresh = await f.peer();
    const restarted = await next.snapshot();
    assert.equal(restarted.counters.attempt, 0);
    await readPages(fresh.client);
    assert.deepEqual(await next.snapshot(), restarted);
    return {
      connections: 52,
      bots: 52,
      pageLimit: 2,
      readCounterDelta: 0,
      pendingStartupPublications: restarted.counters.attempt,
    };
  } finally {
    await f.close();
  }
}
