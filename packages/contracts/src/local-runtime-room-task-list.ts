import { localRuntimeRecord } from './local-runtime.js';
import { localId, localPosition } from './local-runtime-queries.js';
import type { RoomTaskStatus } from './local-runtime-room-tasks.js';
export const LOCAL_ROOM_TASK_LIST = 'room.task-list-v1';
export interface RoomTaskList {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly beforeSeq?: number;
  readonly limit?: number;
}
export interface RoomTaskSummary {
  readonly rootId: string;
  readonly startMessageId: string;
  readonly startSeq: number;
  readonly status: RoomTaskStatus;
  readonly revision: number;
  readonly authority: 'current' | 'historical';
}
export interface RoomTaskListPage {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly roots: readonly RoomTaskSummary[];
  readonly nextBeforeSeq: number | null;
}
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Reflect.ownKeys(v).every((k) => typeof k === 'string' && [...required, ...optional].includes(k));
const positive = (v: unknown): v is number => localPosition(v) && v > 0;
export function isRoomTaskList(v: unknown): v is RoomTaskList {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['workspaceId', 'roomId'], ['beforeSeq', 'limit']) &&
    localId(v['workspaceId']) &&
    localId(v['roomId']) &&
    (v['beforeSeq'] === undefined || positive(v['beforeSeq'])) &&
    (v['limit'] === undefined || (positive(v['limit']) && v['limit'] <= 50))
  );
}
function summary(v: unknown): v is RoomTaskSummary {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['rootId', 'startMessageId', 'startSeq', 'status', 'revision', 'authority']) &&
    localId(v['rootId']) &&
    localId(v['startMessageId']) &&
    positive(v['startSeq']) &&
    localPosition(v['revision']) &&
    typeof v['status'] === 'string' &&
    ['ready', 'waiting', 'paused', 'completed', 'stopped'].includes(v['status']) &&
    (v['authority'] === 'current' || v['authority'] === 'historical')
  );
}
export function isRoomTaskListPage(v: unknown): v is RoomTaskListPage {
  if (
    !localRuntimeRecord(v) ||
    !exact(v, ['workspaceId', 'roomId', 'roots', 'nextBeforeSeq']) ||
    !localId(v['workspaceId']) ||
    !localId(v['roomId']) ||
    !Array.isArray(v['roots']) ||
    v['roots'].length > 50 ||
    !v['roots'].every(summary)
  )
    return false;
  const roots = v['roots'];
  return (
    new Set(roots.map((r) => r.rootId)).size === roots.length &&
    new Set(roots.map((r) => r.startMessageId)).size === roots.length &&
    roots.every((r, i) => i === 0 || r.startSeq < roots[i - 1]!.startSeq) &&
    (v['nextBeforeSeq'] === null ||
      (positive(v['nextBeforeSeq']) && v['nextBeforeSeq'] === roots.at(-1)?.startSeq))
  );
}
