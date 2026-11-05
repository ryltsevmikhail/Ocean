import { expect, it, vi } from 'vitest';
import { createBotModels } from './bot-model-state.js';
import type { LocalBoundBot } from '../model-protocol.js';
const bot = (version: number, connectionId: string): LocalBoundBot => ({
  bot: {
    id: 'a',
    workspaceId: 'ws_ocean',
    handle: 'a',
    name: 'A',
    role: 'role',
    provider: 'p',
    model: 'm',
    profileVersion: version,
  },
  binding: { connectionId, modelId: 'm' },
});
const page = (item: LocalBoundBot) => ({
  version: 1,
  workspaceId: 'ws_ocean',
  roomId: null,
  items: [item],
  nextAfter: null,
});
it('retires only the exact definitive CAS refusal, refreshes, then permits a later explicit v2 edit', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(bot(1, 'old')))
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page(bot(2, 'peer')))
    .mockRejectedValueOnce(Error('bot_profile_version_conflict'))
    .mockResolvedValueOnce(page(bot(2, 'peer')))
    .mockResolvedValueOnce(bot(3, 'later'));
  const s = createBotModels(request);
  await s.load();
  await s.save(s.bots.value[0]!, { connectionId: 'unknown', modelId: 'm' });
  const original = s.pending['a'];
  await s.retry('a');
  expect(s.pending['a']).toBeUndefined();
  expect(s.stale.value).toBe(false);
  expect(s.bots.value[0]?.bot.profileVersion).toBe(2);
  expect(s.bots.value[0]?.binding?.connectionId).toBe('peer');
  expect(request.mock.calls.filter((x) => x[0].op === 'bot-binding-set')).toHaveLength(2);
  await s.save(s.bots.value[0]!, { connectionId: 'later', modelId: 'm' });
  const writes = request.mock.calls.filter((x) => x[0].op === 'bot-binding-set');
  expect(writes).toHaveLength(3);
  expect(writes[2]?.[0].input.expectedProfileVersion).toBe(2);
  expect(writes[2]?.[0].input.requestId).not.toBe(original?.input.requestId);
});
it.each(['request_conflict', 'connection_closed', 'provider_write_failed'])(
  'does not retire an unknown binding original on %s',
  async (code) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(bot(1, 'old')))
      .mockRejectedValueOnce(Error('connection_closed'))
      .mockResolvedValueOnce(page(bot(2, 'peer')))
      .mockRejectedValueOnce(Error(code))
      .mockResolvedValueOnce(page(bot(2, 'peer')));
    const s = createBotModels(request);
    await s.load();
    await s.save(s.bots.value[0]!, { connectionId: 'unknown', modelId: 'm' });
    const original = s.pending['a'];
    await s.retry('a');
    expect(s.pending['a']).toEqual(original);
    await s.save(s.bots.value[0]!, { connectionId: 'new', modelId: 'm' });
    expect(request.mock.calls.filter((x) => x[0].op === 'bot-binding-set')).toHaveLength(2);
  },
);

it('clears a successful historical original without replacing the newer peer binding', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(bot(1, 'old')))
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page(bot(3, 'peer-newer')))
    .mockResolvedValueOnce(bot(2, 'original'));
  const s = createBotModels(request);
  await s.load();
  await s.save(s.bots.value[0]!, { connectionId: 'original', modelId: 'm' });
  await s.retry('a');
  expect(s.pending['a']).toBeUndefined();
  expect(s.bots.value[0]?.bot.profileVersion).toBe(3);
  expect(s.bots.value[0]?.binding?.connectionId).toBe('peer-newer');
  expect(s.stale.value).toBe(false);
});
it('does not retire a different request original when an older retry is definitively refused', async () => {
  let refuse!: (e: Error) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(bot(1, 'old')))
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page(bot(2, 'peer')))
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          refuse = reject;
        }),
    )
    .mockResolvedValueOnce(page(bot(2, 'peer')));
  const s = createBotModels(request);
  await s.load();
  await s.save(s.bots.value[0]!, { connectionId: 'original', modelId: 'm' });
  const retry = s.retry('a');
  const before = s.pending['a']!;
  s.pending['a'] = { ...before, input: { ...before.input, requestId: 'different-original' } };
  refuse(Error('bot_profile_version_conflict'));
  await retry;
  expect(s.pending['a']?.input.requestId).toBe('different-original');
});
it('does not retire a new-context original on a previous-context CAS response', async () => {
  let refuse!: (e: Error) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(bot(1, 'old')))
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page(bot(2, 'peer')))
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          refuse = reject;
        }),
    )
    .mockResolvedValueOnce(page(bot(1, 'new-context')));
  const s = createBotModels(request);
  await s.load();
  await s.save(s.bots.value[0]!, { connectionId: 'original', modelId: 'm' });
  const original = s.pending['a']!;
  const retry = s.retry('a');
  s.reset();
  await s.load();
  s.pending['a'] = { ...original, input: { ...original.input, requestId: 'new-context-original' } };
  refuse(Error('bot_profile_version_conflict'));
  await retry;
  expect(s.pending['a']?.input.requestId).toBe('new-context-original');
  expect(s.bots.value[0]?.binding?.connectionId).toBe('new-context');
});
