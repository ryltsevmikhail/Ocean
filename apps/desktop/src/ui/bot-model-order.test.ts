import { expect, it, vi } from 'vitest';
import { createBotModels } from './bot-model-state.js';
import type { LocalBoundBot } from '../model-protocol.js';
const bot = (version: number, connectionId: string, id = 'a'): LocalBoundBot => ({
  bot: {
    id,
    workspaceId: 'ws_ocean',
    handle: id,
    name: id,
    role: 'role',
    provider: 'p',
    model: 'm',
    profileVersion: version,
  },
  binding: { connectionId, modelId: 'm' },
});
const page = (items: LocalBoundBot[]) => ({
  version: 1,
  workspaceId: 'ws_ocean',
  roomId: null,
  items,
  nextAfter: null,
});
it('treats v2 delayed acknowledgement as historical after a fresh v3 page', async () => {
  let ack!: (v: LocalBoundBot) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([bot(1, 'old')]))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          ack = r;
        }),
    )
    .mockResolvedValueOnce(page([bot(3, 'newer')]));
  const s = createBotModels(request);
  await s.load();
  const saving = s.save(s.bots.value[0]!, { connectionId: 'saved', modelId: 'm' });
  await s.load();
  ack(bot(2, 'saved'));
  await saving;
  expect(s.bots.value[0]?.bot.profileVersion).toBe(3);
  expect(s.bots.value[0]?.binding?.connectionId).toBe('newer');
  expect(s.stale.value).toBe(false);
});
it('reconciles a page that began before the acknowledgement and clears stale with fresh other rows', async () => {
  let ack!: (v: LocalBoundBot) => void, old!: (v: ReturnType<typeof page>) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([bot(1, 'old'), bot(1, 'other', 'b')]))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          ack = r;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          old = r;
        }),
    )
    .mockResolvedValueOnce(page([bot(2, 'saved'), bot(3, 'new-other', 'b')]));
  const s = createBotModels(request);
  await s.load();
  const saving = s.save(s.bots.value[0]!, { connectionId: 'saved', modelId: 'm' });
  const reading = s.load();
  ack(bot(2, 'saved'));
  await saving;
  old(page([bot(1, 'old'), bot(1, 'other', 'b')]));
  await reading;
  expect(s.bots.value.map((x) => x.bot.profileVersion)).toEqual([2, 3]);
  expect(s.bots.value[1]?.binding?.connectionId).toBe('new-other');
  expect(s.stale.value).toBe(false);
});

it('resets version knowledge only for an explicit authority-context reset', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([bot(9, 'previous')]))
    .mockResolvedValueOnce(page([bot(1, 'new-context')]));
  const s = createBotModels(request);
  await s.load();
  s.reset();
  await s.load();
  expect(s.bots.value[0]?.bot.profileVersion).toBe(1);
  expect(s.stale.value).toBe(false);
});

it('cannot apply a previous authority acknowledgement after an explicit reset', async () => {
  let ack!: (v: LocalBoundBot) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([bot(8, 'previous')]))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          ack = r;
        }),
    )
    .mockResolvedValueOnce(page([bot(1, 'new-context')]));
  const s = createBotModels(request);
  await s.load();
  const saving = s.save(s.bots.value[0]!, { connectionId: 'old-save', modelId: 'm' });
  s.reset();
  await s.load();
  ack(bot(9, 'old-save'));
  await saving;
  expect(s.bots.value[0]?.bot.profileVersion).toBe(1);
  expect(s.bots.value[0]?.binding?.connectionId).toBe('new-context');
});
