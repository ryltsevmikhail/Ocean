import { expect, it } from 'vitest';
import { admitChat } from './direct-chat-admission.js';
import { activationFixture } from '../test-fixtures/provider-activation.js';
import { activation } from '../test-fixtures/model-turn.js';
import { admitBroadcastChild } from './room-broadcast-runner.js';
import { RoomBroadcastService } from './room-broadcast.js';

it.each(['legacy', 'host', 'cloud'] as const)(
  'deny refuses %s before context image resolution and writes',
  (mode) => {
    const f = activationFixture();
    f.store.atomic((tx) =>
      tx.putRoomModelPolicy({ roomId: f.request.roomId, cloudTransfer: 'deny', revision: 2 }),
    );
    const snapshot = activation();
    const resolver =
      mode === 'cloud'
        ? {
            resolve: () => ({
              ok: true as const,
              value: {
                provider: f.provider,
                snapshot: {
                  ...snapshot,
                  identity: {
                    source: 'connection' as const,
                    connectionId: 'cloud',
                    modelId: 'scripted',
                    providerId: 'scripted',
                    connectionRevision: 1,
                    botProfileVersion: 1,
                    kind: 'cloud' as const,
                    endpoint: 'https://cloud.example',
                    auth: 'api_key' as const,
                    artifactDigest: null,
                    backendVersion: null,
                  },
                },
              },
            }),
          }
        : f.resolver;
    const result = admitChat(f, f.request, mode === 'legacy' ? f.provider : { resolver }, {
      mode: 'admit',
      codingAvailable: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'model_transfer_denied' } });
    expect(
      f.store.atomic((tx) => [
        tx.chatTurns(),
        tx.history(f.request.roomId, 0, 10),
        tx.receipt('turn'),
      ]),
    ).toEqual([[], [], null]);
    expect(f.calls()).toBe(0);
  },
);
it('a frozen queued broadcast is refused under deny before context or provider guard', () => {
  const f = activationFixture();
  const roomId = 'group';
  f.store.atomic((tx) => {
    const second = { ...f.bot, id: 'second', handle: 'second' };
    tx.putBot(second);
    tx.putRoom({
      id: roomId,
      workspaceId: f.bot.workspaceId,
      kind: 'group',
      title: 'Group',
      botIds: [f.bot.id, second.id],
    });
  });
  const service = new RoomBroadcastService(f);
  const batch = service.submit({
    workspaceId: f.bot.workspaceId,
    roomId,
    requestId: 'broadcast',
    text: 'hello',
  });
  if (!batch.ok) throw Error('fixture');
  const turn = f.store.atomic((tx) => tx.broadcastTurns(batch.value.id)[0]);
  if (!turn) throw Error('fixture turn');
  f.store.atomic((tx) => tx.putRoomModelPolicy({ roomId, cloudTransfer: 'deny', revision: 2 }));
  const result = admitBroadcastChild(f.store, batch.value.id, turn.id, {
    resolver: f.resolver,
    clock: f.clock,
    guard: () => {
      throw Error('must refuse before context guard');
    },
  });
  expect(result).toMatchObject({ kind: 'refused', code: 'model_transfer_denied' });
  expect(f.store.atomic((tx) => tx.chatTurn(turn.id))).toMatchObject({
    status: 'failed',
    failureCode: 'model_transfer_denied',
    modelBinding: turn.modelBinding,
  });
  expect(f.calls()).toBe(0);
});

import { imageChatFixture, prepared, requestId } from '../test-fixtures/image-chat.test.js';
import { ProviderActivationService } from './provider-activation.js';
import { RoomModelPolicyService } from './room-model-policy.js';

it('deny blocks image resolution and provider body serialization; another room stays eligible', () => {
  let images = 0;
  const f = imageChatFixture({
    resolve: () => {
      images++;
      throw Error('must not resolve');
    },
  });
  f.store.atomic((tx) =>
    tx.putRoomModelPolicy({ roomId: f.flashRoom.id, cloudTransfer: 'deny', revision: 2 }),
  );
  const denied = admitChat(
    f.deps,
    { workspaceId: 'ws_ocean', roomId: f.flashRoom.id, requestId, text: prepared },
    f.provider,
    { mode: 'admit', codingAvailable: false },
  );
  expect(denied).toMatchObject({ ok: false, error: { code: 'model_transfer_denied' } });
  expect(images).toBe(0);
  expect(f.provider.requests).toEqual([]);
  expect(
    admitChat(
      f.deps,
      { workspaceId: 'ws_ocean', roomId: f.proRoom.id, requestId: 'other-room', text: 'hello' },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    ).ok,
  ).toBe(true);
});
it('unavailable explicit local connection admits a deny policy but refuses activation with zero cloud fallback', () => {
  const f = activationFixture();
  const local = {
    ...f.store.read('legacy:scripted')!,
    connectionId: 'local',
    kind: 'local' as const,
    auth: 'none' as const,
    endpoint: 'http://127.0.0.1:1234',
    intent: 'disconnected' as const,
    revision: 1,
  };
  f.store.put(local, null);
  f.store.atomic((tx) =>
    tx.putModelBinding(f.bot.id, { connectionId: 'local', modelId: 'scripted' }),
  );
  expect(
    new RoomModelPolicyService({ store: f.store, connections: f.store }).set({
      workspaceId: f.request.workspaceId,
      roomId: f.request.roomId,
      requestId: 'deny',
      expectedRevision: 1,
      cloudTransfer: 'deny',
    }).ok,
  ).toBe(true);
  const resolver = new ProviderActivationService({
    connections: f.store,
    restored: false,
    disabled: false,
    factory: {
      catalog: () => {
        throw Error('no catalog');
      },
      activate: () => {
        throw Error('no activation');
      },
      external: () => {
        throw Error('no cloud fallback');
      },
    },
    secrets: {
      read: () => {
        throw Error('no secrets');
      },
      write: () => {},
      replace: () => {},
      remove: () => {},
    },
  });
  expect(
    admitChat(f, f.request, { resolver }, { mode: 'admit', codingAvailable: false }),
  ).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
  expect(f.calls()).toBe(0);
});
it('connection-backed local identity remains eligible in deny, unlike a matching host display name', () => {
  const f = activationFixture();
  const local = {
    ...f.store.read('legacy:scripted')!,
    connectionId: 'local',
    kind: 'local' as const,
    auth: 'none' as const,
    endpoint: 'http://127.0.0.1:1234',
    intent: 'active' as const,
    revision: 1,
  };
  f.store.put(local, null);
  f.store.atomic((tx) => {
    tx.putModelBinding(f.bot.id, { connectionId: 'local', modelId: 'scripted' });
    tx.putRoomModelPolicy({ roomId: f.request.roomId, cloudTransfer: 'deny', revision: 2 });
  });
  const resolver = new ProviderActivationService({
    connections: f.store,
    restored: false,
    disabled: false,
    factory: {
      catalog: () => [{ modelId: 'scripted', capabilities: f.snapshot.capabilities }],
      activate: () => ({
        source: 'auth_none',
        provider: f.provider,
        check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['scripted'] }),
      }),
      external: () => {
        throw Error('no fallback');
      },
    },
    secrets: {
      read: () => {
        throw Error('no secrets');
      },
      write: () => {},
      replace: () => {},
      remove: () => {},
    },
  });
  expect(
    admitChat(f, f.request, { resolver }, { mode: 'admit', codingAvailable: false }),
  ).toMatchObject({
    ok: true,
    value: {
      turn: {
        status: 'accepted',
        activation: { identity: { source: 'connection', kind: 'local', connectionId: 'local' } },
      },
    },
  });
});
it('missing authoritative policy refuses allow admission before image context', () => {
  const f = activationFixture();
  const deps = {
    ...f,
    store: {
      atomic: <T>(work: Parameters<typeof f.store.atomic<T>>[0]): T =>
        f.store.atomic((tx) => work({ ...tx, roomModelPolicy: () => null })),
    },
  };
  expect(
    admitChat(deps, f.request, f.provider, { mode: 'admit', codingAvailable: false }),
  ).toMatchObject({ ok: false, error: { code: 'model_policy_unavailable' } });
  expect(f.calls()).toBe(0);
});
