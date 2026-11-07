import { z } from 'zod';
import {
  isRoomTaskList,
  isRoomTaskListPage,
  isRoomTaskStart,
  isRoomTaskReceipt,
  isRoomTaskGet,
  isRoomTaskRootView,
  isRoomTaskRow,
  isRoomTaskStop,
  isRoomTaskStopReceipt,
  isRoomTaskObserve,
  isRoomTaskObservation,
  type RoomTaskRootView,
  type RoomTaskStart,
  type RoomTaskGet,
  type RoomTaskObserve,
} from '@runnets/contracts';
import { dto } from './protocol-dto.js';
const scoped = <T extends { workspaceId: string }>(guard: (v: unknown) => v is T) =>
  dto((v: unknown): v is T => guard(v) && v.workspaceId === 'ws_ocean');
export const taskBinding = z.strictObject({
  profileId: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.uuid(),
});
export type TaskBinding = z.infer<typeof taskBinding>;
export const taskCommands = [
  z.strictObject({ op: z.literal('task-support') }),
  z.strictObject({
    op: z.literal('task-list'),
    binding: taskBinding,
    input: scoped(isRoomTaskList),
  }),
  z.strictObject({
    op: z.literal('task-start'),
    binding: taskBinding,
    input: scoped(isConversationTaskStart),
  }),
  z.strictObject({
    op: z.literal('task-get'),
    binding: taskBinding,
    input: scoped(isAssembledGet),
  }),
  z.strictObject({
    op: z.literal('task-observe'),
    binding: taskBinding,
    input: scoped(isShortObserve),
  }),
  z.strictObject({
    op: z.literal('task-stop'),
    binding: taskBinding,
    input: scoped(isRoomTaskStop),
  }),
] as const;
function isConversationTaskStart(v: unknown): v is RoomTaskStart {
  return (
    isRoomTaskStart(v) &&
    v.mandate.projectId === null &&
    v.mandate.codingTaskId === null &&
    v.mandate.permissions.every((p) => p.kind === 'service')
  );
}
function isAssembledGet(v: unknown): v is RoomTaskGet {
  return isRoomTaskGet(v) && !Object.hasOwn(v, 'page');
}
function isShortObserve(v: unknown): v is RoomTaskObserve {
  return isRoomTaskObserve(v) && (v.waitMs === undefined || v.waitMs <= 1000);
}
// The public wire validator remains capped at 50. Validate the closed header independently,
// then every assembled row and its UTF-8 byte key, matching the public SDK.
export function isAssembledTaskView(v: unknown): v is RoomTaskRootView {
  if (typeof v !== 'object' || v === null || !('rows' in v) || !Array.isArray(v.rows)) return false;
  const keys = [
    'workspaceId',
    'roomId',
    'rootId',
    'status',
    'revision',
    'fenceReason',
    'counts',
    'rows',
    'nextPage',
  ];
  if (Reflect.ownKeys(v).length !== keys.length || !keys.every((key) => Object.hasOwn(v, key)))
    return false;
  const rows: unknown[] = Array.from(v.rows);
  if (
    !isRoomTaskRootView({ ...v, rows: [] }) ||
    !('nextPage' in v) ||
    v.nextPage !== null ||
    rows.length > 512
  )
    return false;
  let previous: Uint8Array | null = null;
  return rows.every((row) => {
    if (!isRoomTaskRow(row)) return false;
    const key = new TextEncoder().encode(
      (row.type === 'task' ? '0' : row.type === 'delivery' ? '1' : '2') +
        (row.type === 'slice' ? row.turnId : row.id),
    );
    if (previous && compareBytes(previous, key) >= 0) return false;
    previous = key;
    return true;
  });
}
export const taskOutputs = {
  'task-support': taskBinding.extend({ supported: z.boolean() }).strict(),
  'task-list': scoped(isRoomTaskListPage),
  'task-start': scoped(isRoomTaskReceipt),
  'task-get': scoped(isAssembledTaskView),
  'task-observe': dto(isRoomTaskObservation),
  'task-stop': scoped(isRoomTaskStopReceipt),
};
export type TaskCommand = z.infer<(typeof taskCommands)[number]>;
export function taskReplyMatches(c: TaskCommand, value: unknown): boolean {
  if (c.op === 'task-support') return true;
  const parsed = taskOutputs[c.op].safeParse(value);
  if (!parsed.success) return false;
  const v = parsed.data;
  const scope = 'view' in v ? v.view : v;
  if (scope.workspaceId !== c.input.workspaceId || scope.roomId !== c.input.roomId) return false;
  if ('rootId' in c.input && (!('rootId' in scope) || scope.rootId !== c.input.rootId))
    return false;
  if (c.op === 'task-observe' && 'instanceId' in v && v.instanceId !== c.binding.instanceId)
    return false;
  if (c.op === 'task-list' && 'roots' in v)
    return (
      v.roots.length <= (c.input.limit ?? 50) &&
      (v.nextBeforeSeq === null || v.roots.length === (c.input.limit ?? 50)) &&
      (c.input.beforeSeq === undefined || v.roots.every((r) => r.startSeq < c.input.beforeSeq!))
    );
  if (c.op === 'task-start' && 'deliveries' in v)
    return (
      JSON.stringify(v.deliveries.map((d) => d.botId)) === JSON.stringify(c.input.initialBotIds)
    );
  if (c.op === 'task-stop' && 'requestId' in v)
    return v.requestId === c.input.requestId && v.expectedRevision === c.input.expectedRevision;
  return true;
}
export const isTaskCommand = (c: { op: string }): c is TaskCommand => c.op.startsWith('task-');

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); ++i) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
