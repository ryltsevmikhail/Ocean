import { expect, it, vi } from 'vitest';
import { createBotModels } from './bot-model-state.js';
import type { LocalBoundBot } from '@runnets/contracts';
const bot = (id: string, connectionId: string): LocalBoundBot => ({
  bot: {
    id,
    workspaceId: 'ws_ocean',
    handle: id,
    name: id,
    role: 'role',
    provider: 'p',
    model: 'm',
    profileVersion: 3,
  },
  binding: { connectionId, modelId: 'm' },
});
it('preserves two exact bindings through byte-short pages and refresh', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      version: 1,
      workspaceId: 'ws_ocean',
      roomId: null,
      items: [bot('a', 'c1')],
      nextAfter: 'a',
    })
    .mockResolvedValueOnce({
      version: 1,
      workspaceId: 'ws_ocean',
      roomId: null,
      items: [bot('b', 'c2')],
      nextAfter: null,
    });
  const state = createBotModels(request);
  await state.load();
  expect(state.bots.value.map((x) => x.binding?.connectionId)).toEqual(['c1', 'c2']);
  expect(request.mock.calls[1]?.[0]).toMatchObject({ input: { after: 'a' } });
  request.mockResolvedValueOnce({
    version: 1,
    workspaceId: 'ws_ocean',
    roomId: null,
    items: [bot('a', 'c1'), bot('b', 'c2')],
    nextAfter: null,
  });
  await state.load();
  expect(state.bots.value.map((x) => x.binding)).toEqual([
    { connectionId: 'c1', modelId: 'm' },
    { connectionId: 'c2', modelId: 'm' },
  ]);
});
it('saves only one bot with the displayed version and explicit binding', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      version: 1,
      workspaceId: 'ws_ocean',
      roomId: null,
      items: [bot('a', 'c1'), bot('b', 'c2')],
      nextAfter: null,
    })
    .mockResolvedValueOnce({
      ...bot('a', 'c3'),
      bot: { ...bot('a', 'c3').bot, profileVersion: 4 },
    });
  const state = createBotModels(request);
  await state.load();
  await state.save(state.bots.value[0]!, { connectionId: 'c3', modelId: 'm' });
  expect(request.mock.calls[1]?.[0]).toMatchObject({
    op: 'bot-binding-set',
    input: { botId: 'a', expectedProfileVersion: 3, binding: { connectionId: 'c3', modelId: 'm' } },
  });
  expect(state.bots.value[1]?.binding?.connectionId).toBe('c2');
});
it('refreshes on conflict and requires another explicit save', async () => {
  const page = {
    version: 1,
    workspaceId: 'ws_ocean',
    roomId: null,
    items: [bot('a', 'c1')],
    nextAfter: null,
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page)
    .mockRejectedValueOnce(Error('bot_profile_version_conflict'))
    .mockResolvedValueOnce({ ...page, items: [bot('a', 'new')] });
  const state = createBotModels(request);
  await state.load();
  await state.save(state.bots.value[0]!, { connectionId: 'c3', modelId: 'm' });
  expect(request).toHaveBeenCalledTimes(3);
  expect(state.bots.value[0]?.binding?.connectionId).toBe('new');
  expect(state.message.value).toContain('измен');
});

it('retains an unknown bot-binding request and explicitly replays the same identity', async () => {
  const page = {
    version: 1,
    workspaceId: 'ws_ocean',
    roomId: null,
    items: [bot('a', 'c1')],
    nextAfter: null,
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page)
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page)
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page);
  const s = createBotModels(request);
  await s.load();
  await s.save(s.bots.value[0]!, { connectionId: 'new', modelId: 'm' });
  await s.save(s.bots.value[0]!, { connectionId: 'other', modelId: 'm' });
  await s.retry('a');
  const writes = request.mock.calls.filter((x) => x[0].op === 'bot-binding-set');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[0]).toEqual(writes[1]?.[0]);
});

it('does not replace a confirmed binding with an older concurrently read page', async () => {
  const page = {
    version: 1,
    workspaceId: 'ws_ocean',
    roomId: null,
    items: [bot('a', 'c1')],
    nextAfter: null,
  };
  let save!: (v: LocalBoundBot) => void, read!: (v: typeof page) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          save = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          read = resolve;
        }),
    );
  const s = createBotModels(request);
  await s.load();
  const saving = s.save(s.bots.value[0]!, { connectionId: 'c3', modelId: 'm' });
  const reading = s.load();
  save({ ...bot('a', 'c3'), bot: { ...bot('a', 'c3').bot, profileVersion: 4 } });
  await saving;
  read(page);
  await reading;
  expect(s.bots.value[0]?.bot.profileVersion).toBe(4);
  expect(s.bots.value[0]?.binding?.connectionId).toBe('c3');
});
