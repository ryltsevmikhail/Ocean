import { expect, it } from 'vitest';
import * as application from './index.js';
import { bindingFixture, createBinding } from '../test-fixtures/bot-model-binding.js';

it('persists default, CAS mutations and historical receipts in the room transaction', () => {
  const f = bindingFixture();
  const created = f.service.create(createBinding);
  if (!created.ok) throw Error('fixture');
  const room = f.old.execute({
    type: 'OpenDirectRoom',
    workspaceId: 'w',
    requestId: 'room',
    botId: created.value.bot.id,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('fixture');
  expect(application.RoomModelPolicyService).toBeTypeOf('function');
  const policy = new application.RoomModelPolicyService({
    store: f.store,
    connections: f.connections,
  });
  const input = {
    workspaceId: 'w',
    roomId: room.value.data.id,
    requestId: 'policy',
    expectedRevision: 1,
    cloudTransfer: 'allow' as const,
  };
  expect(f.store.atomic((tx) => tx.roomModelPolicy(input.roomId))).toEqual({
    roomId: input.roomId,
    cloudTransfer: 'allow',
    revision: 1,
  });
  const result = policy.set(input);
  expect(result).toEqual({
    ok: true,
    value: { roomId: input.roomId, cloudTransfer: 'allow', revision: 2 },
  });
  expect(policy.set(input)).toEqual(result);
  expect(policy.set({ ...input, requestId: 'stale' })).toMatchObject({
    ok: false,
    error: { code: 'model_policy_revision_conflict' },
  });
  expect(
    policy.set({ ...input, requestId: 'deny', expectedRevision: 2, cloudTransfer: 'deny' }),
  ).toMatchObject({ ok: false, error: { code: 'model_policy_members_conflict' } });
  expect(f.store.atomic((tx) => tx.receipt('deny'))).toBeNull();
});

import { policyFixture } from '../test-fixtures/room-model-policy.js';
import { activation } from '../test-fixtures/model-turn.js';
import type { ChatTurn } from '@runnets/domain';

it('checks every deny room before rebind, keeping profile/binding/receipt unchanged', () => {
  const f = policyFixture();
  expect(f.policy.set(f.input).ok).toBe(true);
  const other = f.service.create({ ...createBinding, handle: 'other', requestId: 'other' });
  if (!other.ok) throw Error('fixture');
  expect(
    f.old.execute({
      type: 'CreateGroupRoom',
      workspaceId: 'w',
      requestId: 'group',
      title: 'Mixed',
      botIds: [f.bot.id, other.value.bot.id],
    }).ok,
  ).toBe(true);
  const input = {
    workspaceId: 'w',
    botId: f.bot.id,
    expectedProfileVersion: 1,
    requestId: 'rebind',
    binding: createBinding.binding,
  };
  expect(f.service.set(input)).toMatchObject({
    ok: false,
    error: { code: 'model_transfer_denied' },
  });
  expect(
    f.store.atomic((tx) => [tx.bot(f.bot.id), tx.modelBinding(f.bot.id), tx.receipt('rebind')]),
  ).toEqual([f.bot, { connectionId: 'local', modelId: 'one' }, null]);
  expect(f.service.set({ ...input, binding: { connectionId: 'local', modelId: 'two' } }).ok).toBe(
    true,
  );
});
it.each(['queued', 'accepted', 'dispatching', 'prepared', 'uncertain'] as const)(
  'frozen unknown %s work blocks deny independently of current local member',
  (status) => {
    const f = policyFixture();
    const turn: ChatTurn = {
      id: 'turn',
      workspaceId: 'w',
      roomId: f.room.id,
      requestId: 'turn',
      taskRunId: 'run',
      inboundMessageId: 'message',
      readThroughSeq: 1,
      bot: f.bot,
      modelBinding: createBinding.binding,
      activation: activation(),
      status,
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
      ...(status === 'uncertain' ? { continuationReviewId: 'review' } : {}),
    };
    f.store.atomic((tx) => tx.putChatTurn(turn));
    expect(f.policy.set(f.input)).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
    expect(
      f.store.atomic((tx) => [
        tx.roomModelPolicy(f.room.id),
        tx.receipt('policy'),
        tx.chatTurn('turn'),
      ]),
    ).toEqual([{ roomId: f.room.id, cloudTransfer: 'allow', revision: 1 }, null, turn]);
    f.store.atomic((tx) => tx.putChatTurn({ ...turn, status: 'cancelled' }));
    expect(f.policy.set(f.input).ok).toBe(true);
  },
);
it('validates strict scalar inputs, scope, replay conflicts and missing policy without writes', () => {
  const f = policyFixture();
  for (const change of [
    { expectedRevision: 0 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { expectedRevision: '1' },
    { cloudTransfer: ['deny'] },
    { roomId: [] },
    { workspaceId: null },
  ])
    expect(f.policy.set({ ...f.input, ...change } as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  expect(f.policy.set({ ...f.input, workspaceId: 'other' })).toMatchObject({
    ok: false,
    error: { code: 'workspace_conflict' },
  });
  expect(f.policy.set({ ...f.input, roomId: 'missing' })).toMatchObject({
    ok: false,
    error: { code: 'unknown_room' },
  });
  expect(f.policy.set(f.input).ok).toBe(true);
  expect(f.policy.set({ ...f.input, cloudTransfer: 'allow' })).toMatchObject({
    ok: false,
    error: { code: 'request_conflict' },
  });
  const missing = new application.RoomModelPolicyService({
    store: {
      atomic: (work) => f.store.atomic((tx) => work({ ...tx, roomModelPolicy: () => null })),
    },
    connections: f.connections,
  });
  expect(missing.set({ ...f.input, requestId: 'missing' })).toMatchObject({
    ok: false,
    error: { code: 'model_policy_unavailable' },
  });
});
it('rolls policy back if the receipt write throws', () => {
  const f = policyFixture();
  const policy = new application.RoomModelPolicyService({
    store: {
      atomic: (work) =>
        f.store.atomic((tx) =>
          work({
            ...tx,
            putReceipt: () => {
              throw Error('receipt rejected');
            },
          }),
        ),
    },
    connections: f.connections,
  });
  expect(() => policy.set(f.input)).toThrow('receipt rejected');
  expect(f.store.atomic((tx) => tx.roomModelPolicy(f.room.id)?.revision)).toBe(1);
});
