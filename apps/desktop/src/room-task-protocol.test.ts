import { expect, it, vi, afterEach } from 'vitest';
import { isRoomTaskRootView, type RoomTaskRootView } from '@runnets/contracts';
import { commands, outputs } from './protocol.js';
import { call } from './ui/bridge.js';
export const binding = {
  profileId: 'a'.repeat(64),
  instanceId: '11111111-1111-4111-8111-111111111111',
};
export const input = { workspaceId: 'ws_ocean', roomId: 'r', rootId: 'root' };
export function view(count = 1): RoomTaskRootView {
  return {
    ...input,
    status: 'ready',
    revision: 1,
    fenceReason: null,
    counts: { active: 1, slices: 0, modelStarts: 0, toolCalls: 0 },
    nextPage: null,
    rows: Array.from({ length: count }, (_, i) => ({
      type: 'task',
      id: `task_${String(i).padStart(3, '0')}`,
      parentId: null,
      botId: 'a',
      status: 'ready',
      waitingChildId: null,
      hold: null,
    })),
  };
}
afterEach(() => vi.unstubAllGlobals());
it('accepts only typed fixed workspace commands and a distinct complete assembled view above wire page size', () => {
  expect(commands.safeParse({ op: 'task-get', binding, input }).success).toBe(true);
  for (const bad of [
    { ...input, workspaceId: 'foreign' },
    { ...input, page: 'opaque' },
  ])
    expect(commands.safeParse({ op: 'task-get', binding, input: bad }).success).toBe(false);
  const guard = (outputs as Record<string, { safeParse(v: unknown): { success: boolean } }>)[
    'task-get'
  ];
  expect(guard, 'assembled IPC output exists').toBeDefined();
  expect(isRoomTaskRootView(view(51))).toBe(false);
  expect(guard!.safeParse(view(51)).success).toBe(true);
  for (const bad of [
    view(513),
    { ...view(), secret: 'x' },
    { ...view(), nextPage: 'partial' },
    { ...view(2), rows: [...view(2).rows].reverse() },
    { ...view(), rows: [view().rows[0], view().rows[0]] },
  ])
    expect(guard!.safeParse(bad).success).toBe(false);
});
it('renderer refuses foreign successful task frames even if structurally valid', async () => {
  vi.stubGlobal('window', {
    ocean: {
      request: async () => ({ version: 1, ok: true, data: { ...view(51), roomId: 'foreign' } }),
    },
  });
  await expect(call({ op: 'task-get', binding, input } as never)).rejects.toThrow(
    'outcome_unknown',
  );
});
it('rejects hidden extra header keys, sparse rows and Unicode rows that are out of UTF-8 byte order', () => {
  const guard = (outputs as Record<string, { safeParse(v: unknown): { success: boolean } }>)[
    'task-get'
  ]!;
  const hidden = Object.defineProperty(view(), 'secret', { value: 'hidden' });
  expect(guard.safeParse(hidden).success).toBe(false);
  expect(guard.safeParse({ ...view(), rows: Array(1) }).success).toBe(false);
  const first = { ...view().rows[0], id: '\u{10000}' },
    second = { ...view().rows[0], id: '\ue000' };
  expect(guard.safeParse({ ...view(), rows: [first, second] }).success).toBe(false);
  expect(guard.safeParse({ ...view(), rows: [second, first] }).success).toBe(true);
});
it('accepts optional closed service-grant identity binding while preserving legacy reads and rejecting malformed bindings', () => {
  expect(commands.safeParse({ op: 'service-grants' }).success).toBe(true);
  expect(commands.safeParse({ op: 'service-grants', binding }).success).toBe(true);
  for (const bad of [
    null,
    {},
    { profileId: binding.profileId },
    { ...binding, profileId: 'foreign' },
    { ...binding, instanceId: 'invalid' },
    { ...binding, extra: true },
  ])
    expect(commands.safeParse({ op: 'service-grants', binding: bad }).success).toBe(false);
});
