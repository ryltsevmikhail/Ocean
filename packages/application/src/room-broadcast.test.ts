import { describe, expect, it } from 'vitest';
import type { BroadcastBatch } from '@runnets/domain';
import { broadcastFixture } from '../test-fixtures/broadcast-fixture.js';
import {
  admitBroadcastChild,
  nextBroadcastChild,
  settleBroadcastBatch,
} from './room-broadcast-runner.js';

function setup() {
  const f = broadcastFixture();
  const submitted = f.service.submit({
    workspaceId: 'ws',
    roomId: f.roomId,
    requestId: 'broadcast-1',
    text: 'Вопрос всем',
    attachments: ['att_1'],
  });
  if (!submitted.ok) throw Error('fixture submit: ' + submitted.error.code);
  return { ...f, batch: submitted.value };
}
function batchOf(f: ReturnType<typeof broadcastFixture>, batchId: string): BroadcastBatch {
  return f.store.atomic((tx) => tx.broadcastBatch(batchId))!;
}

describe('broadcast admission', () => {
  it('admits one user message, a frozen ordered child list and the context boundary atomically', () => {
    const f = setup();
    const batch = f.batch;
    expect(batch).toMatchObject({
      version: 1,
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'broadcast-1',
      boundarySeq: 1,
      state: 'open',
      revision: 1,
    });
    expect(batch.messageId).toMatch(/^[0-9]+$/);
    expect(batch.recipients.map((child) => child.position)).toEqual([0, 1]);
    expect(batch.recipients.map((child) => child.botId)).toEqual(f.botIds);
    expect(batch.recipients.every((child) => child.provider === 'test')).toBe(true);
    const history = f.conversations.history('ws', f.roomId);
    expect(history.ok && history.value).toHaveLength(1);
    const turns = f.store.atomic((tx) => tx.broadcastTurns(batch.id));
    expect(turns.map((turn) => turn.status)).toEqual(['queued', 'queued']);
    expect(turns.map((turn) => turn.broadcast?.position)).toEqual([0, 1]);
    expect(turns[0]?.inboundMessageId).toBe(batch.messageId);
    // A queued child never occupies the single-active-room hold.
    expect(f.store.atomic((tx) => tx.activeChatTurn(f.roomId))).toBeNull();
  });
  it('never adds a member created after admission to the frozen batch', () => {
    const f = setup();
    const created = f.conversations.execute({
      type: 'CreateBot',
      workspaceId: 'ws',
      requestId: 'late-bot',
      handle: 'late',
      name: 'Late',
      role: 'fixture',
      provider: 'test',
      model: 'test',
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('late bot');
    const frozen = f.service.get({ workspaceId: 'ws', roomId: f.roomId, batchId: f.batch.id });
    expect(frozen.recipients.map((child) => child.handle)).toEqual(
      f.batch.recipients.map((child) => child.handle),
    );
    expect(f.store.atomic((tx) => tx.broadcastTurns(f.batch.id))).toHaveLength(2);
  });
  it('replays the identical request and conflicts on changed data', () => {
    const f = setup();
    const replay = f.service.submit({
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'broadcast-1',
      text: 'Вопрос всем',
      attachments: ['att_1'],
    });
    expect(replay.ok && replay.value).toEqual(f.batch);
    const changed = f.service.submit({
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'broadcast-1',
      text: 'другой текст',
      attachments: ['att_1'],
    });
    expect(!changed.ok && changed.error.code).toBe('request_conflict');
    expect(f.conversations.history('ws', f.roomId).ok).toBe(true);
  });
  it('refuses a second batch or a model turn while one is open, while notes stay possible', () => {
    const f = setup();
    expect(
      f.service.submit({
        workspaceId: 'ws',
        roomId: f.roomId,
        requestId: 'broadcast-2',
        text: 'ещё вопрос',
      }),
    ).toMatchObject({ ok: false, error: { code: 'batch_open' } });
    const note = f.conversations.execute({
      type: 'RecordUserMessage',
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'note-1',
      text: 'Заметка без модели',
    });
    expect(note.ok && note.value.kind).toBe('message');
  });
  it('rejects direct rooms and invalid attachment payloads before any commit', () => {
    const f = broadcastFixture();
    const direct = f.conversations.execute({
      type: 'OpenDirectRoom',
      workspaceId: 'ws',
      requestId: 'direct',
      botId: f.dev,
    });
    if (!direct.ok || direct.value.kind !== 'room') throw Error('direct fixture');
    expect(
      f.service.submit({
        workspaceId: 'ws',
        roomId: direct.value.data.id,
        requestId: 'broadcast-direct',
        text: 'всем',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    for (const attachments of [['a', 'a'], ['a', 'b', 'c', 'd', 'e'], ['']])
      expect(
        f.service.submit({
          workspaceId: 'ws',
          roomId: f.roomId,
          requestId: 'broadcast-bad',
          text: 'всем',
          attachments,
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('broadcast frozen context and runner transitions', () => {
  it('freezes history before the boundary and never includes a sibling answer', () => {
    const f = broadcastFixture();
    f.conversations.execute({
      type: 'RecordUserMessage',
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'older-note',
      text: 'старая заметка',
    });
    f.store.atomic((tx) => {
      const seq = tx.nextSequence(f.roomId);
      tx.putMessage({
        id: 'peer-old',
        workspaceId: 'ws',
        roomId: f.roomId,
        seq,
        author: 'bot',
        authorBotId: f.dev,
        targetBotId: f.dev,
        turnId: 'turn-old',
        body: 'старый ответ коллеги',
        createdAt: '2026-11-04T00:00:00.000Z',
      });
    });
    const submitted = f.service.submit({
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'broadcast-1',
      text: 'Вопрос всем',
    });
    if (!submitted.ok) throw Error('submit');
    const batch = submitted.value;
    const turns = f.store.atomic((tx) => tx.broadcastTurns(batch.id));
    // First child answers and publishes after the boundary.
    f.update(turns[0]!, 'completed');
    f.store.atomic((tx) => {
      tx.putMessage({
        id: 'reply-sibling',
        workspaceId: 'ws',
        roomId: f.roomId,
        seq: tx.nextSequence(f.roomId),
        author: 'bot',
        authorBotId: turns[0]!.bot.id,
        targetBotId: turns[0]!.bot.id,
        turnId: turns[0]!.id,
        body: 'ответ первого',
        createdAt: '2026-11-04T00:00:00.000Z',
      });
    });
    const admitted = admitBroadcastChild(f.store, batch.id, turns[1]!.id);
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const contents = admitted.value.messages.map((message) => message.content);
    expect(contents[0]).toContain('fixture');
    expect(contents[1]).toBe('старая заметка');
    expect(contents[2]).toContain('старый ответ коллеги');
    expect(contents[2]).toContain('dev');
    expect(contents[3]).toBe('Вопрос всем');
    expect(contents.some((content) => content.includes('ответ первого'))).toBe(false);
    expect(admitted.value.turn.status).toBe('accepted');
  });
  it('serializes children, supports visible refusal and settles only when all are terminal', () => {
    const f = setup();
    const first = nextBroadcastChild(f.store, f.batch.id);
    expect(first?.turn.broadcast?.position).toBe(0);
    if (first === null) return;
    expect(admitBroadcastChild(f.store, f.batch.id, first.turn.id).kind).toBe('admitted');
    // While the first child is not terminal the next one must not be admitted.
    expect(nextBroadcastChild(f.store, f.batch.id)).toBeNull();
    f.update(first.turn, 'failed');
    const second = nextBroadcastChild(f.store, f.batch.id);
    expect(second?.turn.broadcast?.position).toBe(1);
    if (second === null) return;
    expect(admitBroadcastChild(f.store, f.batch.id, second.turn.id).kind).toBe('admitted');
    f.update(second.turn, 'completed');
    const settled = settleBroadcastBatch(f.store, f.clock, f.batch.id);
    expect(settled).toMatchObject({ state: 'completed', revision: 2 });
    expect(settled?.recipients.map((child) => child.state)).toEqual(['refused', 'answered']);
    expect(batchOf(f, f.batch.id).state).toBe('completed');
    expect(nextBroadcastChild(f.store, f.batch.id)).toBeNull();
  });
  it('refuses a child whose frozen identity is no longer a room member', () => {
    const f = setup();
    const turns = f.store.atomic((tx) => tx.broadcastTurns(f.batch.id));
    // A member added after admission is never in the frozen list; a frozen identity that a
    // later room edit no longer includes must be refused visibly instead of dispatched.
    const created = f.conversations.execute({
      type: 'CreateBot',
      workspaceId: 'ws',
      requestId: 'outsider',
      handle: 'outsider',
      name: 'Outsider',
      role: 'fixture',
      provider: 'test',
      model: 'test',
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('outsider');
    const stranger = created.value.data;
    f.store.atomic((tx) => tx.putChatTurn({ ...turns[0]!, bot: stranger }));
    const admitted = admitBroadcastChild(f.store, f.batch.id, turns[0]!.id);
    expect(admitted.kind).toBe('refused');
    if (admitted.kind !== 'refused') return;
    expect(admitted.turn.status).toBe('failed');
  });
});
