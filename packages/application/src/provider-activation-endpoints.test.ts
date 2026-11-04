import { expect, it } from 'vitest';
import { InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import { imageChatFixture } from '../test-fixtures/image-chat.test.js';
import { ProviderActivationService } from './provider-activation.js';
import { DirectChatService } from './direct-chat.js';
import { TaskRunService } from './service.js';
import { admitBroadcastChild } from './room-broadcast-runner.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';

const invalidEndpoints = [
  'http://example.invalid',
  'https://user@example.invalid/v1',
  'https://user:password@example.invalid/v1',
  'https://example.invalid/v1?key=value',
  'https://example.invalid/v1#fragment',
  'https://example.invalid?',
  'https://example.invalid#',
  'https://example.invalid/',
  'https://EXAMPLE.invalid',
  'https://example.invalid:443',
  'https://example.invalid/v1/../api',
  ' https://example.invalid',
];
function fixture(endpoint: string, credential: 'saved' | 'external') {
  const f = imageChatFixture();
  const calls: string[] = [];
  const previous = f.store.read('legacy:deepseek')!;
  const record = {
    ...previous,
    endpoint,
    revision: 1,
    intent: 'active' as const,
    secretRef: credential === 'saved' ? 'fixture-secret-ref' : null,
  };
  f.store.put(record, 0);
  const factory: ModelCredentialFactory = {
    catalog: () => {
      calls.push('catalog');
      return [
        {
          modelId: 'deepseek-flash',
          capabilities: {
            tools: true,
            streaming: true,
            inputModalities: ['text'],
            contextTokens: null,
            maxOutputTokens: null,
            usage: 'reported',
          },
        },
      ];
    },
    activate: () => {
      calls.push('activate');
      return {
        source: 'saved',
        provider: f.provider,
        check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['deepseek-flash'] }),
      };
    },
    external: () => {
      calls.push('external');
      return {
        source: 'external',
        provider: f.provider,
        check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['deepseek-flash'] }),
      };
    },
  };
  const resolver = new ProviderActivationService({
    connections: f.store.modelConnections,
    factory,
    restored: false,
    disabled: false,
    secrets: {
      read: () => {
        calls.push('secret');
        return { status: 'ok', key: 'fixture-key' };
      },
      write: () => {},
      replace: () => {},
      remove: () => {},
    },
  });
  const tasks = new TaskRunService({
    log: new InMemoryEventLog(),
    ids: new SequentialIdGenerator(),
    clock: f.clock,
  });
  const chat = new DirectChatService({ ...f.deps, tasks });
  return { ...f, resolver, calls, chat, record };
}
for (const credential of ['saved', 'external'] as const) {
  it.each(invalidEndpoints)(
    `refuses persisted ${credential} direct endpoint %s before catalog or credentials`,
    async (endpoint) => {
      const f = fixture(endpoint, credential);
      const result = f.chat.submit({
        workspaceId: 'ws_ocean',
        roomId: f.flashRoom.id,
        requestId: 'invalid-endpoint',
        text: 'hello',
        resolver: f.resolver,
        signal: new AbortController().signal,
        emit: () => {},
      });
      if (result.ok) await result.value.completion?.catch(() => {});
      expect(result).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
      expect(f.calls).toEqual([]);
      expect(f.provider.requests).toEqual([]);
      expect(
        f.store.atomic((tx) => [
          tx.chatTurns(),
          tx.history(f.flashRoom.id, 0, 10),
          tx.receipt('invalid-endpoint'),
        ]),
      ).toEqual([[], [], null]);
      expect(f.store.read('legacy:deepseek')).toEqual(f.record);
    },
  );
  it.each(invalidEndpoints)(
    `refuses persisted ${credential} broadcast endpoint %s before catalog or credentials`,
    (endpoint) => {
      const f = fixture(endpoint, credential);
      const queued = f.service.submit({
        workspaceId: 'ws_ocean',
        roomId: f.groupRoom.id,
        requestId: 'invalid-broadcast',
        text: 'hello',
      });
      if (!queued.ok) throw Error('queue');
      const child = f.store.atomic((tx) =>
        tx.broadcastTurns(queued.value.id).find((turn) => turn.bot.id === f.flash.id)!,
      );
      expect(
        admitBroadcastChild(f.store, queued.value.id, child.id, {
          resolver: f.resolver,
          clock: f.clock,
        }),
      ).toMatchObject({ kind: 'refused', code: 'provider_unavailable' });
      expect(f.calls).toEqual([]);
      expect(f.provider.requests).toEqual([]);
      expect(f.store.read('legacy:deepseek')).toEqual(f.record);
    },
  );
}
it.each(['https://configured.invalid/v1', 'https://configured.invalid/v1/'])(
  'retains a valid configured HTTPS path without rewriting %s',
  (endpoint) => {
    const f = fixture(endpoint, 'saved');
    const result = f.resolver.resolve(
      { bot: f.flash, binding: { connectionId: 'legacy:deepseek', modelId: 'deepseek-flash' } },
      f.clock.now().toISOString(),
    );
    expect(result).toMatchObject({ ok: true, value: { snapshot: { identity: { endpoint } } } });
    expect(f.calls).toEqual(['catalog', 'secret', 'activate']);
    expect(f.store.read('legacy:deepseek')).toEqual(f.record);
  },
);
for (const credential of ['saved', 'external'] as const) {
  it(`admits a valid configured custom HTTPS path in ${credential} direct and broadcast paths`, async () => {
    const endpoint = 'https://configured.invalid/v1';
    const direct = fixture(endpoint, credential);
    const result = direct.chat.submit({
      workspaceId: 'ws_ocean',
      roomId: direct.flashRoom.id,
      requestId: 'valid-custom',
      text: 'hello',
      resolver: direct.resolver,
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('admission');
    expect((await result.value.completion)?.status).toBe('completed');
    expect(direct.store.atomic((tx) => tx.chatTurns()[0]?.activation?.identity)).toMatchObject({
      source: 'connection',
      endpoint,
    });
    const broadcast = fixture(endpoint, credential);
    const queued = broadcast.service.submit({
      workspaceId: 'ws_ocean',
      roomId: broadcast.groupRoom.id,
      requestId: 'valid-broadcast',
      text: 'hello',
    });
    if (!queued.ok) throw Error('queue');
    const child = broadcast.store.atomic((tx) =>
      tx.broadcastTurns(queued.value.id).find((turn) => turn.bot.id === broadcast.flash.id)!,
    );
    expect(
      admitBroadcastChild(broadcast.store, queued.value.id, child.id, {
        resolver: broadcast.resolver,
        clock: broadcast.clock,
      }),
    ).toMatchObject({
      kind: 'admitted',
      value: {
        turn: { activation: { identity: { source: 'connection', endpoint } } },
      },
    });
  });
}
it('keeps an unrelated healthy connection usable alongside malformed persisted metadata', async () => {
  const f = fixture('http://invalid-cloud.invalid', 'saved');
  const valid = {
    ...f.record,
    connectionId: 'healthy',
    endpoint: 'https://healthy.invalid/v1',
    legacyEnvironment: false,
  };
  f.store.put(valid, null);
  f.store.atomic((tx) =>
    tx.putModelBinding(f.flash.id, { connectionId: 'healthy', modelId: 'deepseek-flash' }),
  );
  const result = f.chat.submit({
    workspaceId: 'ws_ocean',
    roomId: f.flashRoom.id,
    requestId: 'healthy-turn',
    text: 'hello',
    resolver: f.resolver,
    signal: new AbortController().signal,
    emit: () => {},
  });
  if (!result.ok) throw Error('healthy admission');
  expect((await result.value.completion)?.status).toBe('completed');
  expect(f.store.read('legacy:deepseek')).toEqual(f.record);
  expect(f.store.atomic((tx) => tx.chatTurns()[0]?.activation?.identity)).toMatchObject({
    connectionId: 'healthy',
    endpoint: 'https://healthy.invalid/v1',
  });
});
