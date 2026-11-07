import type * as Contracts from '@runnets/contracts';
import { expect, it, vi } from 'vitest';
vi.mock('@runnets/contracts', async (original) => ({
  ...(await original<typeof Contracts>()),
  // Model a future current validator accepting an extended ordinary DTO.
  isBotProfile: () => true,
  isRoomRecord: () => true,
  isLocalRunSnapshot: () => true,
}));
import { localRoomClient } from '../../test-fixtures/rc2-room-client.js';
import { localProfileClient } from '../../test-fixtures/rc2-profile-client.js';
const bot = {
  workspaceId: 'ws_ocean',
  id: 'bot',
  profileVersion: 1,
  handle: 'local',
  name: 'Local',
  role: 'fixture',
  provider: 'ollama',
  model: 'qwen3:1.7b',
};
it('rejects a future bot field independently of the current runtime guard', async () => {
  const client = localProfileClient(async () => [{ ...bot, activation: 'future' }]);
  await expect(client.listBots({ workspaceId: 'ws_ocean' })).rejects.toThrow('invalid_frame');
});
it('rejects a future room field independently of the current runtime guard', async () => {
  const client = localProfileClient(async () => ({
    kind: 'room',
    data: {
      id: 'room',
      workspaceId: 'ws_ocean',
      kind: 'direct',
      botId: 'bot',
      activation: 'future',
    },
  }));
  await expect(
    client.openDirect({ workspaceId: 'ws_ocean', requestId: 'open', botId: 'bot' }),
  ).rejects.toThrow('invalid_frame');
});

it.each([
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'anthropic', model: 'claude-haiku-5-5' },
  { provider: 'ollama', model: 'qwen3:1.7b' },
])('decodes the historical exact ordinary profile for $provider', async (profile) => {
  const row = { ...bot, ...profile };
  expect(await localProfileClient(async () => [row]).listBots({ workspaceId: 'ws_ocean' })).toEqual(
    [row],
  );
});
it.each([
  { profileVersion: '1' },
  { profileVersion: -1 },
  { id: 'x'.repeat(129) },
  { provider: ['ollama'] },
  { model: null },
  { workspaceId: 'foreign' },
])('rejects malformed historical profile %j', async (patch) => {
  const client = localProfileClient(async () => [{ ...bot, ...patch }]);
  await expect(client.listBots({ workspaceId: 'ws_ocean' })).rejects.toThrow('invalid_frame');
});
it('rejects page overflow and a future run status using the pinned turn guard', async () => {
  await expect(
    localProfileClient(async () => [bot, bot]).listBots({ workspaceId: 'ws_ocean', limit: 1 }),
  ).rejects.toThrow('invalid_frame');
  const scope = { workspaceId: 'ws_ocean', roomId: 'room' };
  const run = {
    ...scope,
    requestId: 'request',
    runId: 'run',
    messageId: 'message',
    turnId: 'turn',
    performerId: 'bot',
    turnStatus: 'future',
    taskStatus: 'failed',
    version: 7,
    resultMessageId: null,
    pendingDecisionIds: [],
  };
  const client = localRoomClient(async () => [run], {
    protocol: 1,
    profileId: 'a'.repeat(64),
    instanceId: '1'.repeat(36),
    capabilities: ['status'],
  });
  await expect(client.listRuns(scope)).rejects.toThrow('invalid_frame');
});
