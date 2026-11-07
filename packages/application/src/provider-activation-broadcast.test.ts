import { expect, it } from 'vitest';
import { broadcastFixture } from '../test-fixtures/broadcast-fixture.js';
import { admitBroadcastChild } from './room-broadcast-runner.js';
import { injectedProviderActivation } from './provider-activation.js';
import type { ProviderPort } from './provider.js';

function fixture() {
  const f = broadcastFixture();
  const result = f.service.submit({
    workspaceId: 'ws',
    roomId: f.roomId,
    requestId: 'batch',
    text: 'hello',
  });
  if (!result.ok) throw Error('fixture submit');
  const turns = f.store.atomic((tx) => tx.broadcastTurns(result.value.id));
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: false, usage: false },
    async *stream() {
      yield* [];
      throw Error('must not dispatch');
    },
  };
  let calls = 0;
  const resolver = {
    resolve: (...args: Parameters<ReturnType<typeof injectedProviderActivation>['resolve']>) => {
      calls++;
      return injectedProviderActivation(provider).resolve(...args);
    },
  };
  return { ...f, turns, batchId: result.value.id, resolver, calls: () => calls };
}
it('queues frozen bindings and resolves only during queued-to-accepted using the frozen bot', () => {
  const f = fixture();
  const child = f.turns[0]!;
  expect(child.modelBinding).toEqual({ connectionId: 'legacy:test', modelId: 'test' });
  expect(f.calls()).toBe(0);
  f.store.atomic((tx) => {
    tx.replaceBot({ ...child.bot, model: 'new', profileVersion: 2 }, 1);
    tx.putModelBinding(child.bot.id, { connectionId: 'legacy:test', modelId: 'new' });
  });
  const admitted = admitBroadcastChild(f.store, f.batchId, child.id, {
    resolver: f.resolver,
    clock: f.clock,
  });
  expect(admitted).toMatchObject({
    kind: 'admitted',
    value: { turn: { activation: { identity: { modelId: 'test' } }, bot: { profileVersion: 1 } } },
  });
  expect(f.calls()).toBe(1);
  expect(
    admitBroadcastChild(f.store, f.batchId, child.id, { resolver: f.resolver, clock: f.clock })
      .kind,
  ).toBe('closed');
  expect(f.calls()).toBe(1);
});
it('allows only unchanged deterministic legacy bindings for historic queued children', () => {
  const f = fixture();
  const child = f.turns[0]!;
  f.store.atomic((tx) => {
    const { modelBinding: _binding, ...historic } = child;
    tx.putChatTurn(historic);
  });
  expect(
    admitBroadcastChild(f.store, f.batchId, child.id, { resolver: f.resolver, clock: f.clock })
      .kind,
  ).toBe('admitted');
});
it('refuses historical queues after a model edit without consulting credentials', () => {
  const f = fixture();
  const child = f.turns[0]!;
  f.store.atomic((tx) => {
    const { modelBinding: _binding, ...historic } = child;
    tx.putChatTurn(historic);
    tx.replaceBot({ ...child.bot, model: 'new', profileVersion: 2 }, 1);
  });
  expect(
    admitBroadcastChild(f.store, f.batchId, child.id, { resolver: f.resolver, clock: f.clock })
      .kind,
  ).toBe('refused');
  expect(f.calls()).toBe(0);
});
it('keeps a queued child after failed commit and pairs only the subsequent committed capture', () => {
  const f = fixture();
  const child = f.turns[0]!;
  const store = {
    atomic: <T>(work: Parameters<typeof f.store.atomic<T>>[0]): T =>
      f.store.atomic((tx) => {
        work(tx);
        throw Error('commit refused');
      }),
  };
  expect(() =>
    admitBroadcastChild(store, f.batchId, child.id, { resolver: f.resolver, clock: f.clock }),
  ).toThrow('commit refused');
  expect(f.store.atomic((tx) => tx.chatTurn(child.id))).toEqual(child);
  const result = admitBroadcastChild(f.store, f.batchId, child.id, {
    resolver: f.resolver,
    clock: f.clock,
  });
  expect(result.kind).toBe('admitted');
  expect(f.calls()).toBe(2);
  if (result.kind === 'admitted')
    expect(result.value.activation?.snapshot).toEqual(result.value.turn.activation);
});
it('freezes queued identity but captures the current connection revision and actual admission time', async () => {
  const { ProviderActivationService } = await import('./provider-activation.js');
  const f = fixture();
  const child = f.turns[0]!;
  const previous = f.store.read('legacy:test')!;
  const record = {
    ...previous,
    kind: 'local' as const,
    auth: 'none' as const,
    endpoint: 'http://127.0.0.1:8080',
    revision: 1,
    intent: 'active' as const,
  };
  f.store.put(record, 0);
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: false, usage: false },
    async *stream() {
      yield* [];
    },
  };
  let credentials = 0;
  const resolver = new ProviderActivationService({
    connections: f.store.modelConnections,
    restored: false,
    disabled: false,
    secrets: {
      read: () => ({ status: 'absent' }),
      write: () => {},
      replace: () => {},
      remove: () => {},
    },
    factory: {
      catalog: () => [
        {
          modelId: 'test',
          capabilities: {
            tools: false,
            streaming: true,
            inputModalities: ['text'],
            contextTokens: null,
            maxOutputTokens: null,
            usage: 'optional',
          },
        },
      ],
      activate: () => {
        credentials++;
        return {
          source: 'auth_none',
          provider,
          check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['test'] }),
        };
      },
      external: () => null,
    },
  });
  f.store.atomic((tx) => tx.replaceBot({ ...child.bot, profileVersion: 2, model: 'edited' }, 1));
  f.store.put({ ...record, revision: 2, endpoint: 'http://127.0.0.1:9090' }, 1);
  const clock = { now: () => new Date('2026-11-04T00:01:00.000Z') };
  const admitted = admitBroadcastChild(f.store, f.batchId, child.id, { resolver, clock });
  expect(admitted).toMatchObject({
    kind: 'admitted',
    value: {
      turn: {
        activation: {
          identity: {
            modelId: 'test',
            botProfileVersion: 1,
            connectionRevision: 2,
            endpoint: 'http://127.0.0.1:9090',
          },
          admittedAt: '2026-11-04T00:01:00.000Z',
          deadlineAt: '2026-11-04T00:11:00.000Z',
        },
      },
    },
  });
  f.store.put({ ...record, revision: 3, intent: 'disconnected' }, 2);
  expect(
    admitBroadcastChild(f.store, f.batchId, f.turns[1]!.id, { resolver, clock }),
  ).toMatchObject({ kind: 'refused', code: 'provider_unavailable' });
  expect(credentials).toBe(1);
});
