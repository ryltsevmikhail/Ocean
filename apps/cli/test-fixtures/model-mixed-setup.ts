import assert from 'node:assert/strict';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { LocalBoundBot, LocalModelConnectionSetRequest } from '@runnets/contracts';
export const descriptors: LocalModelConnectionSetRequest[] = [
  {
    connectionId: 'local',
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none',
    defaultModelId: 'qwen3:1.7b',
    requestId: 'set-local',
    expectedRevision: null,
  },
  {
    connectionId: 'openai',
    providerId: 'openai',
    kind: 'cloud',
    endpoint: 'https://api.openai.com',
    auth: 'api_key',
    defaultModelId: 'gpt-5.6-terra',
    key: 'synthetic-initial',
    requestId: 'set-openai',
    expectedRevision: null,
  },
  {
    connectionId: 'anthropic',
    providerId: 'anthropic',
    kind: 'cloud',
    endpoint: 'https://api.anthropic.com',
    auth: 'api_key',
    defaultModelId: 'claude-haiku-5-5',
    key: 'synthetic-initial',
    requestId: 'set-anthropic',
    expectedRevision: null,
  },
];
export async function mixedSetup(client: LocalRuntimeClient) {
  const bots: LocalBoundBot[] = [],
    rooms: string[] = [];
  for (const [index, descriptor] of descriptors.entries()) {
    await client.setModelConnection(descriptor);
    assert.equal(
      (await client.checkModelConnection({ connectionId: descriptor.connectionId })).check.outcome,
      'ok',
    );
    const handle = ['aaa-local', 'bbb-openai', 'ccc-anthropic'][index]!;
    const bot = await client.createBoundBot({
      workspaceId: 'ws_ocean',
      requestId: 'bot-' + handle,
      handle,
      name: handle,
      role: 'Synthetic fixture',
      binding: { connectionId: descriptor.connectionId, modelId: descriptor.defaultModelId },
    });
    bots.push(bot);
    rooms.push(
      (
        await client.openDirect({
          workspaceId: 'ws_ocean',
          requestId: 'room-' + handle,
          botId: bot.bot.id,
        })
      ).data.id,
    );
  }
  bots.sort((a, b) => a.bot.id.localeCompare(b.bot.id, 'en'));
  rooms.length = 0;
  for (const [index, previous] of bots.entries()) {
    const descriptor = descriptors[index]!;
    bots[index] = await client.setBotModelBinding({
      workspaceId: 'ws_ocean',
      requestId: 'ordered-binding-' + index,
      botId: previous.bot.id,
      expectedProfileVersion: previous.bot.profileVersion,
      binding: { connectionId: descriptor.connectionId, modelId: descriptor.defaultModelId },
    });
    rooms.push(
      (
        await client.openDirect({
          workspaceId: 'ws_ocean',
          requestId: 'ordered-room-' + index,
          botId: previous.bot.id,
        })
      ).data.id,
    );
  }
  const group = await client.createGroup({
    workspaceId: 'ws_ocean',
    requestId: 'mixed-group',
    title: 'Mixed',
    botIds: bots.map((b) => b.bot.id),
  });
  return { bots, rooms, scope: { workspaceId: 'ws_ocean', roomId: group.data.id } };
}
