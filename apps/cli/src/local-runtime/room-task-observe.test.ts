import type { RoomTaskRootView } from '@runnets/contracts';
import { expect, it, vi } from 'vitest';
import { RuntimeObservers } from './observe.js';
import { roomSlices } from '../../../../packages/store-sqlite/test-fixtures/room-slices.js';
it('resyncs expired root marks and observes durable decision-only changes', async () => {
  const f = roomSlices([]);
  vi.useFakeTimers({ toFake: ['Date'] });
  const reads = f.store.openRoomReads(Date.now),
    observers = new RuntimeObservers(reads, 'instance');
  const start = f.start(),
    q = { workspaceId: f.input.workspaceId, roomId: f.input.roomId, rootId: start.rootId };
  const view = () => f.store.conversations.atomic((tx) => tx.roomTasks!.projection(start.rootId)!);
  const signal = new AbortController().signal;
  try {
    const first = await observers.observeRoot(q, view, signal);
    vi.spyOn(reads, 'decisionRevision').mockReturnValue(1);
    expect((await observers.observeRoot({ ...q, cursor: first.cursor }, view, signal)).kind).toBe(
      'changed',
    );
    const current = await observers.observeRoot(q, view, signal);
    vi.setSystemTime(Date.now() + 300001);
    expect((await observers.observeRoot({ ...q, cursor: current.cursor }, view, signal)).kind).toBe(
      'resync',
    );
  } finally {
    observers.close();
    vi.useRealTimers();
    f.close();
  }
});
it('binds root pages to all rows, scope and expiry while respecting the physical row bound', () => {
  const f = roomSlices([]),
    start = f.start(),
    reads = f.store.openRoomReads(Date.now),
    observers = new RuntimeObservers(reads, 'instance');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const base = f.store.conversations.atomic((tx) =>
      tx.roomTasks!.projection(start.rootId)!,
    ) as RoomTaskRootView;
    const rows = Array.from({ length: 60 }, (_, i) => ({
      type: 'task' as const,
      id: 'task_' + String(i).padStart(3, '0'),
      hold: null,
      parentId: null,
      botId: null,
      status: 'ready' as const,
      waitingChildId: null,
    }));
    const full = { ...base, rows },
      first = observers.rootPage(full);
    expect(first.rows).toHaveLength(50);
    expect(first.nextPage).not.toBeNull();
    const tail = observers.rootPage(full, first.nextPage!);
    expect(tail.rows).toEqual(rows.slice(50));
    expect(tail.nextPage).toBeNull();
    expect(() => observers.rootPage({ ...full, rootId: 'other' }, first.nextPage!)).toThrow(
      'resync_required',
    );
    expect(() =>
      observers.rootPage(
        { ...full, rows: [...rows.slice(0, 59), { ...rows[59]!, status: 'paused' }] },
        first.nextPage!,
      ),
    ).toThrow('resync_required');
    vi.setSystemTime(Date.now() + 300001);
    expect(() => observers.rootPage(full, first.nextPage!)).toThrow('resync_required');
  } finally {
    vi.useRealTimers();
    observers.close();
    f.close();
  }
});
