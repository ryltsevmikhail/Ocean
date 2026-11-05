import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { createOceanTeam, teamPending } from './ocean-team.js';
import type { Bot } from '../protocol.js';
import { modelSupport } from './model-support.js';
afterEach(() => {
  modelSupport.value = null;
  teamPending.value = null;
  vi.unstubAllGlobals();
});
it('requires an explicit binding for every missing team bot before creating any', async () => {
  modelSupport.value = true;
  const request = vi.fn();
  vi.stubGlobal('window', { ocean: { request } });
  await expect(
    createOceanTeam(
      {
        readBots: async () => [],
        setBots: () => {},
        currentBots: () => [],
        refresh: async () => {},
        requestId: () => crypto.randomUUID(),
      },
      { dev: { connectionId: 'a', modelId: 'm' } },
    ),
  ).rejects.toThrow('explicit_bot_binding_required');
  expect(request).not.toHaveBeenCalled();
});
it('creates only the missing bot through the bound API and preserves the existing team member', async () => {
  modelSupport.value = true;
  const existing: Bot = {
    id: 'existing',
    handle: 'dev',
    name: 'dev',
    role: 'dev',
    provider: 'p',
    model: 'old',
  };
  const bots: Bot[] = [existing];
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      version: 1,
      ok: true,
      data: {
        bot: {
          ...existing,
          id: 'new',
          handle: 'review',
          name: 'review',
          role: 'Ревьюер',
          workspaceId: 'ws_ocean',
          profileVersion: 1,
          model: 'm',
        },
        binding: { connectionId: 'b', modelId: 'm' },
      },
    })
    .mockResolvedValueOnce({
      version: 1,
      ok: true,
      data: {
        kind: 'room',
        data: { id: 'group', kind: 'group', title: 'Ocean Team', botIds: ['existing', 'new'] },
      },
    });
  vi.stubGlobal('window', { ocean: { request } });
  const refresh = vi.fn();
  const readBots = vi
    .fn()
    .mockResolvedValueOnce([existing])
    .mockResolvedValue([existing, { ...existing, id: 'new', handle: 'review' }]);
  await createOceanTeam(
    {
      readBots,
      setBots: (next) => bots.splice(0, bots.length, ...next),
      currentBots: () => bots,
      refresh,
      requestId: () => crypto.randomUUID(),
    },
    { review: { connectionId: 'b', modelId: 'm' } },
  );
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    op: 'bot-bound-create',
    input: { handle: 'review', binding: { connectionId: 'b', modelId: 'm' } },
  });
  expect(bots[0]).toEqual(existing);
  expect(refresh).toHaveBeenCalledWith('group');
});

it('keeps an uncertain team creation UUID and explicitly replays the same command', async () => {
  modelSupport.value = true;
  const existing: Bot = {
    id: 'existing',
    handle: 'dev',
    name: 'dev',
    role: 'dev',
    provider: 'p',
    model: 'old',
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'connection_closed' } })
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'connection_closed' } });
  vi.stubGlobal('window', { ocean: { request } });
  const deps = {
    readBots: async () => [existing],
    setBots: () => {},
    currentBots: () => [existing],
    refresh: async () => {},
    requestId: () => crypto.randomUUID(),
  };
  const choices = reactive({ review: { connectionId: 'b', modelId: 'm' } });
  await expect(createOceanTeam(deps, choices)).rejects.toThrow();
  await expect(createOceanTeam(deps, choices)).rejects.toThrow();
  expect(request.mock.calls[0]?.[0]).toEqual(request.mock.calls[1]?.[0]);
});
