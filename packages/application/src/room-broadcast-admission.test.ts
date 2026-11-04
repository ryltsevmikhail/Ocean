import { describe, expect, it } from 'vitest';
import { broadcastFixture } from '../test-fixtures/broadcast-fixture.js';

describe('broadcast room admission and abandonment', () => {
  it('distinguishes a batch hold from a non-batch room hold', () => {
    const f = broadcastFixture();
    const before = f.conversations.execute({
      type: 'RecordUserMessage',
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'note-before',
      text: 'заметка',
    });
    expect(before.ok).toBe(true);
    const bot = f.store.atomic((tx) => tx.bot(f.dev));
    if (!bot) throw Error('fixture bot');
    // An uncertain non-batch turn is the pre-existing recovery hold, not a batch.
    f.store.atomic((tx) => {
      tx.putChatTurn({
        id: 'legacy-uncertain',
        workspaceId: 'ws',
        roomId: f.roomId,
        requestId: 'legacy',
        taskRunId: 'tr_legacy',
        inboundMessageId: 'note-before',
        readThroughSeq: 1,
        bot: { ...bot },
        status: 'uncertain',
        text: '',
        preparedVersion: null,
        stopReason: 'end_turn',
      });
    });
    expect(
      f.service.submit({
        workspaceId: 'ws',
        roomId: f.roomId,
        requestId: 'broadcast-after-hold',
        text: 'Вопрос',
      }),
    ).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
  });
  it('reports room_busy for an active non-batch turn and batch_open only for a batch', () => {
    const f = broadcastFixture();
    const bot = f.store.atomic((tx) => tx.bot(f.dev));
    if (!bot) throw Error('fixture bot');
    f.store.atomic((tx) => {
      tx.putChatTurn({
        id: 'legacy-active',
        workspaceId: 'ws',
        roomId: f.roomId,
        requestId: 'legacy',
        taskRunId: 'tr_legacy',
        inboundMessageId: 'legacy-message',
        readThroughSeq: 1,
        bot: { ...bot! },
        status: 'dispatching',
        text: '',
        preparedVersion: null,
        stopReason: 'end_turn',
      });
    });
    expect(
      f.service.submit({
        workspaceId: 'ws',
        roomId: f.roomId,
        requestId: 'broadcast-during-turn',
        text: 'Вопрос',
      }),
    ).toMatchObject({ ok: false, error: { code: 'room_busy' } });
  });
  it('terminalises never-dispatched children on abandonment with an explicit marker', () => {
    const f = broadcastFixture();
    const submitted = f.service.submit({
      workspaceId: 'ws',
      roomId: f.roomId,
      requestId: 'broadcast-abandon',
      text: 'Вопрос',
    });
    if (!submitted.ok) throw Error('submit');
    const turns = f.store.atomic((tx) => tx.broadcastTurns(submitted.value.id));
    f.update(turns[0]!, 'completed');
    f.service.recover();
    const abandoned = f.service.abandon({
      workspaceId: 'ws',
      roomId: f.roomId,
      batchId: submitted.value.id,
      expectedRevision: 2,
    });
    expect(abandoned.recipients.map((child) => child.state)).toEqual(['answered', 'not_started']);
    const after = f.store.atomic((tx) => tx.broadcastTurns(submitted.value.id));
    expect(after[1]).toMatchObject({ status: 'cancelled' });
    expect(after[1]?.broadcast?.abandoned).toBe(true);
    // The uncertain/started child is never terminalised by abandonment.
    expect(after[0]?.status).toBe('completed');
  });
});
