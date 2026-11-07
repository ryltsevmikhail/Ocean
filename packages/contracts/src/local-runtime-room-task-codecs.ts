import { validOwnerGrantReference, validOwnerPermission } from '@runnets/domain';
import { localRuntimeRecord, LOCAL_RUNTIME_MAX_WAIT_MS } from './local-runtime.js';
import { localId, localPosition } from './local-runtime-queries.js';
import type {
  RoomTaskGet,
  RoomTaskStop,
  RoomTaskObserve,
  RoomTaskStart,
  RoomTaskReceipt,
} from './local-runtime-room-tasks.js';
const exact = (
  v: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Reflect.ownKeys(v).every(
    (k) => typeof k === 'string' && (required.includes(k) || optional.includes(k)),
  );
const token = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const scope = (v: Record<string, unknown>) =>
  ['workspaceId', 'roomId', 'rootId'].every((k) => localId(v[k]));
const scopeKeys = ['workspaceId', 'roomId', 'rootId'];
export function isRoomTaskGet(v: unknown): v is RoomTaskGet {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    exact(v, scopeKeys, ['page']) &&
    (v['page'] === undefined || token(v['page']))
  );
}
export function isRoomTaskStop(v: unknown): v is RoomTaskStop {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    exact(v, [...scopeKeys, 'requestId', 'expectedRevision']) &&
    localId(v['requestId']) &&
    localPosition(v['expectedRevision']) &&
    v['expectedRevision'] > 0
  );
}
export function isRoomTaskObserve(v: unknown): v is RoomTaskObserve {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    exact(v, scopeKeys, ['cursor', 'waitMs']) &&
    (v['cursor'] === undefined || token(v['cursor'])) &&
    (v['waitMs'] === undefined ||
      (localPosition(v['waitMs']) && v['waitMs'] <= LOCAL_RUNTIME_MAX_WAIT_MS))
  );
}
export function isRoomTaskStart(v: unknown): v is RoomTaskStart {
  if (
    !localRuntimeRecord(v) ||
    !exact(v, [
      'workspaceId',
      'roomId',
      'requestId',
      'text',
      'initialBotIds',
      'participants',
      'mandate',
    ]) ||
    !['workspaceId', 'roomId', 'requestId'].every((k) => localId(v[k])) ||
    typeof v['text'] !== 'string' ||
    v['text'].trim().length === 0 ||
    new TextEncoder().encode(v['text']).length > 16384
  )
    return false;
  const ids = v['initialBotIds'],
    ps = v['participants'],
    m = v['mandate'];
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 32 &&
    ids.every(localId) &&
    new Set(ids).size === ids.length &&
    Array.isArray(ps) &&
    ps.length > 0 &&
    ps.length <= 32 &&
    ps.every(
      (p: unknown) =>
        localRuntimeRecord(p) &&
        exact(p, ['botId', 'grantReferences'], ['peerTools']) &&
        (!Object.hasOwn(p, 'peerTools') ||
          (Object.prototype.propertyIsEnumerable.call(p, 'peerTools') &&
            p['peerTools'] === false)) &&
        localId(p['botId']) &&
        Array.isArray(p['grantReferences']) &&
        p['grantReferences'].length <= 32 &&
        p['grantReferences'].every(validOwnerGrantReference),
    ) &&
    new Set(ps.map((p: { botId: string }) => p.botId)).size === ps.length &&
    ids.every((id: string) => ps.some((p: { botId: string }) => p.botId === id)) &&
    localRuntimeRecord(m) &&
    exact(m, ['projectId', 'codingTaskId', 'permissions']) &&
    [m['projectId'], m['codingTaskId']].every((x) => x === null || localId(x)) &&
    Array.isArray(m['permissions']) &&
    m['permissions'].length <= 256 &&
    m['permissions'].every(validOwnerPermission)
  );
}
export function isRoomTaskReceipt(v: unknown): v is RoomTaskReceipt {
  if (!localRuntimeRecord(v) || !Array.isArray(v['deliveries'])) return false;
  const deliveries = v['deliveries'];
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    exact(v, [...scopeKeys, 'version', 'messageId', 'seq', 'deliveries']) &&
    v['version'] === 1 &&
    localId(v['messageId']) &&
    localPosition(v['seq']) &&
    v['seq'] > 0 &&
    Array.isArray(v['deliveries']) &&
    v['deliveries'].length > 0 &&
    v['deliveries'].length <= 32 &&
    ['botId', 'taskId', 'deliveryId'].every(
      (k) =>
        new Set(deliveries.map((d: unknown) => (localRuntimeRecord(d) ? d[k] : null))).size ===
        deliveries.length,
    ) &&
    v['deliveries'].every(
      (d: unknown) =>
        localRuntimeRecord(d) &&
        exact(d, ['botId', 'taskId', 'deliveryId']) &&
        ['botId', 'taskId', 'deliveryId'].every((k) => localId(d[k])),
    )
  );
}
export {
  isRoomTaskRow,
  isRoomTaskRootView,
  isRoomTaskStopReceipt,
  isRoomTaskObservation,
} from './local-runtime-room-task-views.js';
