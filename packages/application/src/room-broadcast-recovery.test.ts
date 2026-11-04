import { describe, expect, it } from 'vitest';
import { broadcastFixture } from '../test-fixtures/broadcast-fixture.js';
import { nextBroadcastChild } from './room-broadcast-runner.js';

function paused(withCompletedChild = false) {
  const f = broadcastFixture();
  const submitted = f.service.submit({
    workspaceId: 'ws',
    roomId: f.roomId,
    requestId: 'broadcast-1',
    text: 'всем вопрос',
  });
  if (!submitted.ok) throw Error('submit');
  const batch = submitted.value;
  const turns = f.store.atomic((tx) => tx.broadcastTurns(batch.id));
  if (withCompletedChild) f.update(turns[0]!, 'completed');
  expect(f.service.recover()).toBe(1);
  const recovered = f.service.get({
    workspaceId: 'ws',
    roomId: f.roomId,
    batchId: batch.id,
  });
  expect(recovered.state).toBe('paused');
  return { ...f, batch: recovered, turns };
}
describe('broadcast recovery and owner decisions', () => {
  it('pauses an open batch on startup idempotently and never dispatches queued children', () => {
    const f = paused();
    expect(f.service.recover()).toBe(1);
    expect(
      f.service.get({ workspaceId: 'ws', roomId: f.roomId, batchId: f.batch.id }),
    ).toMatchObject({ state: 'paused', revision: 2 });
    expect(nextBroadcastChild(f.store, f.batch.id)).toBeNull();
    expect(f.batch.recipients.map((child) => child.state)).toEqual(['queued', 'queued']);
  });
  it('continues only when every started child has a known terminal outcome', () => {
    const f = paused(true);
    const continued = f.service.continue({
      workspaceId: 'ws',
      roomId: f.roomId,
      batchId: f.batch.id,
      expectedRevision: 2,
    });
    expect(continued).toMatchObject({ state: 'open', revision: 3 });
    expect(continued.recipients.map((child) => child.state)).toEqual(['answered', 'queued']);
    const next = nextBroadcastChild(f.store, f.batch.id);
    expect(next?.turn.broadcast?.position).toBe(1);
  });
  it('refuses continuation while any started child is uncertain', () => {
    const f = paused();
    f.update(f.turns[0]!, 'uncertain');
    expect(() =>
      f.service.continue({
        workspaceId: 'ws',
        roomId: f.roomId,
        batchId: f.batch.id,
        expectedRevision: 2,
      }),
    ).toThrow('batch_uncertain');
    const abandoned = f.service.abandon({
      workspaceId: 'ws',
      roomId: f.roomId,
      batchId: f.batch.id,
      expectedRevision: 2,
    });
    expect(abandoned).toMatchObject({ state: 'abandoned', revision: 3 });
    expect(abandoned.recipients.map((child) => child.state)).toEqual(['uncertain', 'not_started']);
    // Abandonment is not settlement or cancellation proof for the uncertain child.
    expect(abandoned.recipients[0]?.state).toBe('uncertain');
    const after = f.store.atomic((tx) => tx.broadcastTurns(f.batch.id));
    expect(after[1]).toMatchObject({ status: 'cancelled' });
    expect(after[1]?.broadcast?.abandoned).toBe(true);
    expect(after[0]?.status).toBe('uncertain');
  });
  it('refuses continuation while a relevant text-only hold remains, without settling anything', () => {
    const f = paused(true);
    f.store.atomic((tx) =>
      tx.putRoomPolicy({ roomId: f.roomId, mode: 'text_only', reviewId: 'review-1' }),
    );
    expect(() =>
      f.service.continue({
        workspaceId: 'ws',
        roomId: f.roomId,
        batchId: f.batch.id,
        expectedRevision: 2,
      }),
    ).toThrow('batch_held');
    expect(
      f.service.get({ workspaceId: 'ws', roomId: f.roomId, batchId: f.batch.id }),
    ).toMatchObject({ state: 'paused', revision: 2 });
  });
  it('refuses stale revisions, wrong rooms and unfinished children explicitly', () => {
    const f = paused();
    expect(() =>
      f.service.continue({
        workspaceId: 'ws',
        roomId: f.roomId,
        batchId: f.batch.id,
        expectedRevision: 1,
      }),
    ).toThrow('revision_conflict');
    expect(() =>
      f.service.continue({
        workspaceId: 'ws',
        roomId: 'other-room',
        batchId: f.batch.id,
        expectedRevision: 2,
      }),
    ).toThrow('unknown_batch');
    expect(() =>
      f.service.continue({
        workspaceId: 'other-workspace',
        roomId: f.roomId,
        batchId: f.batch.id,
        expectedRevision: 2,
      }),
    ).toThrow('workspace_conflict');
    f.update(f.turns[0]!, 'prepared');
    expect(() =>
      f.service.continue({
        workspaceId: 'ws',
        roomId: f.roomId,
        batchId: f.batch.id,
        expectedRevision: 2,
      }),
    ).toThrow('batch_uncertain');
  });
  it('treats a repeated identical vote as idempotent and a vote on an open batch as not paused', () => {
    const f = paused(true);
    const vote = {
      workspaceId: 'ws',
      roomId: f.roomId,
      batchId: f.batch.id,
      expectedRevision: 2,
    };
    expect(f.service.continue(vote)).toMatchObject({ state: 'open', revision: 3 });
    expect(f.service.continue(vote)).toMatchObject({ state: 'open', revision: 3 });
    expect(() => f.service.abandon(vote)).toThrow('batch_not_paused');
    const fresh = broadcastFixture();
    const submitted = fresh.service.submit({
      workspaceId: 'ws',
      roomId: fresh.roomId,
      requestId: 'b2',
      text: 'q',
    });
    if (!submitted.ok) throw Error('submit');
    expect(() =>
      fresh.service.continue({
        workspaceId: 'ws',
        roomId: fresh.roomId,
        batchId: submitted.value.id,
        expectedRevision: 1,
      }),
    ).toThrow('batch_not_paused');
    fresh.store.atomic((tx) =>
      tx.putBroadcastBatch({
        ...tx.broadcastBatch(submitted.value.id)!,
        state: 'paused',
        revision: 2,
      }),
    );
    expect(
      fresh.service.abandon({
        workspaceId: 'ws',
        roomId: fresh.roomId,
        batchId: submitted.value.id,
        expectedRevision: 2,
      }),
    ).toMatchObject({ state: 'abandoned', revision: 3 });
  });
  it('keeps completed children answered and never re-dispatches them after continue', () => {
    const f = paused(true);
    f.service.continue({
      workspaceId: 'ws',
      roomId: f.roomId,
      batchId: f.batch.id,
      expectedRevision: 2,
    });
    const next = nextBroadcastChild(f.store, f.batch.id);
    expect(next?.turn.id).toBe(f.turns[1]?.id);
    expect(next?.turn.id).not.toBe(f.turns[0]?.id);
  });
});
