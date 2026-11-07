import { expect, it, vi } from 'vitest';
import type { RoomTaskObservation, RoomTaskRootView } from '@runnets/contracts';
import type { TaskCommand } from '../room-task-protocol.js';
import { createRoomTasks } from './room-task-state.js';
const binding = {
  profileId: 'a'.repeat(64),
  instanceId: '11111111-1111-4111-8111-111111111111',
  supported: true,
};
function view(roomId: string, rootId: string, revision = 1): RoomTaskRootView {
  return {
    workspaceId: 'ws_ocean',
    roomId,
    rootId,
    status: 'ready',
    revision,
    fenceReason: null,
    counts: { active: 1, slices: 0, modelStarts: 0, toolCalls: 0 },
    rows: [],
    nextPage: null,
  };
}
it('keeps at most one physical observer through same-root refresh and scope switches with a held old waiter', async () => {
  let active = 0,
    maximum = 0;
  const waits: { room: string; root: string; finish: () => void }[] = [];
  const request = vi.fn(async (c: TaskCommand | { op: 'service-grants' }) => {
    if (c.op === 'task-support') return binding;
    if (c.op === 'service-grants') return [];
    if (c.op === 'task-list')
      return {
        workspaceId: 'ws_ocean',
        roomId: c.input.roomId,
        roots: ['a', 'b'].map((suffix, i) => ({
          rootId: c.input.roomId + suffix,
          startMessageId: 'message_' + suffix,
          startSeq: 2 - i,
          revision: 1,
          status: 'ready',
          authority: 'current',
        })),
        nextBeforeSeq: null,
      };
    if (c.op === 'task-get') return view(c.input.roomId, c.input.rootId);
    if (c.op === 'task-observe') {
      ++active;
      maximum = Math.max(maximum, active);
      return new Promise<RoomTaskObservation>((yes) =>
        waits.push({
          room: c.input.roomId,
          root: c.input.rootId,
          finish: () => {
            --active;
            yes({
              kind: 'changed',
              cursor: 'cursor',
              instanceId: binding.instanceId,
              view: view(c.input.roomId, c.input.rootId, 999),
            });
          },
        }),
      );
    }
    throw Error('unexpected_write');
  });
  const state = createRoomTasks(request as never);
  await state.context('r');
  expect(active).toBe(1);
  await state.refresh();
  expect(maximum, 'same-root refresh must reuse the existing physical wait').toBe(1);
  await state.select('rb');
  expect(active).toBe(1);
  expect(state.view.value?.rootId).toBe('rb');
  waits[0]!.finish();
  await vi.waitFor(() => expect(waits.at(-1)?.root).toBe('rb'));
  expect(state.view.value?.rootId).toBe('rb');
  expect(state.view.value?.revision).toBe(1);
  await state.context('other');
  expect(state.view.value?.roomId).toBe('other');
  expect(active).toBe(1);
  waits.at(-1)!.finish();
  await vi.waitFor(() => expect(waits.at(-1)?.room).toBe('other'));
  expect(maximum).toBe(1);
  expect(state.view.value?.rootId).toBe('othera');
  expect(state.view.value?.revision).toBe(1);
  state.close();
  waits.at(-1)!.finish();
  await Promise.resolve();
  expect(
    request.mock.calls.filter(([c]) => c.op === 'task-start' || c.op === 'task-stop'),
  ).toHaveLength(0);
});
