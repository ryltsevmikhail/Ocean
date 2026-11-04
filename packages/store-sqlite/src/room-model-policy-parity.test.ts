import { afterEach, expect, it } from 'vitest';
import { InMemoryConversationStore } from '@runnets/store';
import type { ChatTurn } from '@runnets/domain';
import { activation } from '../../application/test-fixtures/model-turn.js';
import { policyFixture } from '../../application/test-fixtures/room-model-policy.js';
import { createBinding } from '../../application/test-fixtures/bot-model-binding.js';
import { openSqliteStore } from './index.js';

const close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup();
});
for (const adapter of ['memory', 'sqlite']) {
  function fixture() {
    if (adapter === 'memory') return policyFixture(new InMemoryConversationStore());
    const db = openSqliteStore({ path: ':memory:' });
    close.push(() => db.close());
    return policyFixture(db.conversations, db.modelConnections);
  }
  it(`${adapter}: current-member conflict and multiroom rebind refuse without any writes`, () => {
    const f = fixture();
    expect(f.policy.set(f.input).ok).toBe(true);
    const input = {
      workspaceId: 'w',
      requestId: 'set',
      botId: f.bot.id,
      expectedProfileVersion: 1,
      binding: createBinding.binding,
    };
    expect(f.service.set(input)).toMatchObject({
      ok: false,
      error: { code: 'model_transfer_denied' },
    });
    expect(
      f.store.atomic((tx) => [tx.bot(f.bot.id), tx.receipt('set'), tx.modelBinding(f.bot.id)]),
    ).toEqual([f.bot, null, { connectionId: 'local', modelId: 'one' }]);
    expect(f.policy.set({ ...f.input, cloudTransfer: 'allow' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(f.policy.set({ ...f.input, requestId: 'stale' })).toMatchObject({
      ok: false,
      error: { code: 'model_policy_revision_conflict' },
    });
  });
  it.each(['queued', 'accepted', 'dispatching', 'prepared', 'uncertain'] as const)(
    `${adapter}: frozen %s cloud/unknown work holds deny after local rebind`,
    (status) => {
      const f = fixture();
      const turn: ChatTurn = {
        id: 'turn',
        workspaceId: 'w',
        roomId: f.room.id,
        requestId: 'turn',
        taskRunId: 'run',
        inboundMessageId: 'm',
        readThroughSeq: 1,
        bot: f.bot,
        modelBinding: createBinding.binding,
        activation: {
          ...activation(),
          identity: {
            source: 'connection',
            connectionId: 'shared',
            modelId: 'one',
            providerId: 'deepseek',
            kind: 'cloud',
            endpoint: 'https://api.deepseek.com',
            auth: 'api_key',
            connectionRevision: 1,
            botProfileVersion: 1,
            artifactDigest: null,
            backendVersion: null,
          },
        },
        status,
        text: '',
        preparedVersion: null,
        stopReason: 'end_turn',
      };
      f.store.atomic((tx) => tx.putChatTurn(turn));
      expect(f.policy.set(f.input)).toMatchObject({
        ok: false,
        error: { code: 'model_policy_work_conflict' },
      });
      expect(
        f.store.atomic((tx) => [tx.roomModelPolicy(f.room.id)?.revision, tx.receipt('policy')]),
      ).toEqual([1, null]);
      f.store.atomic((tx) => tx.putChatTurn({ ...turn, status: 'completed' }));
      expect(f.policy.set(f.input).ok).toBe(true);
    },
  );
  it(`${adapter}: exact replay remains historical after a later policy mutation`, () => {
    const f = fixture();
    const original = f.policy.set(f.input);
    expect(original.ok).toBe(true);
    expect(
      f.policy.set({ ...f.input, requestId: 'later', expectedRevision: 2, cloudTransfer: 'allow' }),
    ).toMatchObject({ ok: true, value: { revision: 3 } });
    expect(f.policy.set(f.input)).toEqual(original);
    expect(f.store.atomic((tx) => tx.roomModelPolicy(f.room.id))).toEqual({
      roomId: f.room.id,
      cloudTransfer: 'allow',
      revision: 3,
    });
  });
  it(`${adapter}: reviewed uncertainty still holds deny after text-only continuation and queued sibling abandonment`, () => {
    const f = fixture();
    const turn: ChatTurn = {
      id: 'turn',
      workspaceId: 'w',
      roomId: f.room.id,
      requestId: 'turn',
      taskRunId: 'run',
      inboundMessageId: 'm',
      readThroughSeq: 1,
      bot: f.bot,
      activation: {
        ...activation(),
        identity: {
          source: 'connection',
          connectionId: 'shared',
          modelId: 'one',
          providerId: 'deepseek',
          kind: 'cloud',
          endpoint: 'https://api.deepseek.com',
          auth: 'api_key',
          connectionRevision: 1,
          botProfileVersion: 1,
          artifactDigest: null,
          backendVersion: null,
        },
      },
      status: 'uncertain',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    };
    f.store.atomic((tx) => {
      tx.putChatTurn(turn);
      tx.putMessage({
        id: 'notice',
        workspaceId: 'w',
        roomId: f.room.id,
        seq: 1,
        author: 'user',
        targetBotId: f.bot.id,
        body: 'text-only review',
        createdAt: 'now',
      });
      tx.putReview({
        id: 'review',
        workspaceId: 'w',
        roomId: f.room.id,
        turnId: turn.id,
        taskRunId: turn.taskRunId,
        actor: 'owner',
        mode: 'text_only',
        observedVersion: 'version',
        reason: 'Reviewed',
        noticeMessageId: 'notice',
        createdAt: 'now',
      });
      tx.putChatTurn({ ...turn, continuationReviewId: 'review' });
      tx.putRoomPolicy({ roomId: f.room.id, mode: 'text_only', reviewId: 'review' });
      tx.putChatTurn({ ...turn, id: 'sibling', taskRunId: 'sibling-run', status: 'cancelled' });
    });
    expect(f.store.atomic((tx) => tx.activeChatTurn(f.room.id))).toBeNull();
    expect(f.policy.set(f.input)).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
    expect(f.store.atomic((tx) => tx.chatTurn(turn.id)?.status)).toBe('uncertain');
  });
  it(`${adapter}: local frozen work does not hold cloud policy; terminal cloud history is retained`, () => {
    const f = fixture();
    const turn: ChatTurn = {
      id: 'turn',
      workspaceId: 'w',
      roomId: f.room.id,
      requestId: 'turn',
      taskRunId: 'run',
      inboundMessageId: 'm',
      readThroughSeq: 1,
      bot: f.bot,
      activation: {
        ...activation(),
        identity: {
          source: 'connection',
          connectionId: 'local',
          modelId: 'one',
          providerId: 'local-fixture',
          kind: 'local',
          endpoint: 'http://127.0.0.1:1234',
          auth: 'none',
          connectionRevision: 1,
          botProfileVersion: 1,
          artifactDigest: null,
          backendVersion: null,
        },
      },
      status: 'dispatching',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    };
    f.store.atomic((tx) => tx.putChatTurn(turn));
    expect(f.policy.set(f.input).ok).toBe(true);
    expect(f.store.atomic((tx) => tx.chatTurn(turn.id))).toEqual(turn);
  });
}
