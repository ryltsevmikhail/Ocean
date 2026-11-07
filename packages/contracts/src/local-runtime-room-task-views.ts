import { TASK_RUN_STATUSES } from '@runnets/domain';
import { localRuntimeRecord, LOCAL_RUNTIME_MAX_FRAME } from './local-runtime.js';
import { localId, localPosition } from './local-runtime-queries.js';
import type {
  RoomTaskRow,
  RoomTaskRootView,
  RoomTaskStopReceipt,
  RoomTaskObservation,
} from './local-runtime-room-tasks.js';
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const token = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const scopeKeys = ['workspaceId', 'roomId', 'rootId'];
const scope = (v: Record<string, unknown>) => scopeKeys.every((k) => localId(v[k]));
const member = (values: readonly string[], v: unknown) =>
  typeof v === 'string' && values.includes(v);
const coreStatuses = [
  'absent',
  'unknown',
  'admitted_before_run',
  'not_created',
  ...TASK_RUN_STATUSES,
];
const statuses = ['ready', 'waiting', 'paused', 'completed', 'stopped'];
const holds = [
  null,
  'queued',
  'waiting',
  'stopped',
  'paused',
  'unknown',
  'authority_denied',
  'slice_limit',
  'model_limit',
  'tool_limit',
  'duplicate_exchange',
];
const nullableId = (v: unknown) => v === null || localId(v);
export function isRoomTaskRow(v: unknown): v is RoomTaskRow {
  if (!localRuntimeRecord(v) || !holds.includes(v['hold'] as null)) return false;
  if (v['type'] === 'task')
    return (
      exact(v, ['type', 'hold', 'id', 'parentId', 'botId', 'status', 'waitingChildId']) &&
      localId(v['id']) &&
      nullableId(v['parentId']) &&
      nullableId(v['botId']) &&
      nullableId(v['waitingChildId']) &&
      member(statuses, v['status'])
    );
  if (v['type'] === 'delivery')
    return (
      exact(v, [
        'type',
        'hold',
        'id',
        'kind',
        'fromTaskId',
        'toTaskId',
        'causeId',
        'state',
        'messageId',
        'seq',
      ]) &&
      ['id', 'toTaskId', 'causeId', 'messageId'].every((k) => localId(v[k])) &&
      nullableId(v['fromTaskId']) &&
      member(['start', 'message', 'delegate', 'result'], v['kind']) &&
      member(['queued', 'claimed', 'consumed', 'held'], v['state']) &&
      localPosition(v['seq']) &&
      v['seq'] > 0
    );
  return (
    v['type'] === 'slice' &&
    exact(v, [
      'type',
      'hold',
      'taskId',
      'deliveryId',
      'runId',
      'turnId',
      'turnStatus',
      'taskStatus',
      'version',
      'disposition',
      'resultMessageId',
      'pendingDecisionIds',
    ]) &&
    ['taskId', 'deliveryId', 'runId', 'turnId'].every((k) => localId(v[k])) &&
    member(
      ['accepted', 'dispatching', 'prepared', 'completed', 'uncertain', 'failed', 'cancelled'],
      v['turnStatus'],
    ) &&
    member(coreStatuses, v['taskStatus']) &&
    localPosition(v['version']) &&
    (v['disposition'] === null || v['disposition'] === 'yielded') &&
    nullableId(v['resultMessageId']) &&
    (v['disposition'] !== 'yielded' || v['resultMessageId'] === null) &&
    Array.isArray(v['pendingDecisionIds']) &&
    v['pendingDecisionIds'].length <= 200 &&
    v['pendingDecisionIds'].every(localId)
  );
}
export function isRoomTaskRootView(v: unknown): v is RoomTaskRootView {
  if (
    !localRuntimeRecord(v) ||
    !scope(v) ||
    !exact(v, [...scopeKeys, 'status', 'revision', 'fenceReason', 'counts', 'rows', 'nextPage']) ||
    !member(statuses, v['status']) ||
    !localPosition(v['revision']) ||
    v['revision'] < 1 ||
    !localRuntimeRecord(v['counts']) ||
    !exact(v['counts'], ['active', 'slices', 'modelStarts', 'toolCalls']) ||
    !Object.values(v['counts']).every(localPosition) ||
    !['active', 'slices', 'modelStarts', 'toolCalls'].every((k) =>
      Object.hasOwn(v['counts'] as Record<string, unknown>, k),
    ) ||
    !Array.isArray(v['rows']) ||
    v['rows'].length > 50 ||
    !v['rows'].every(isRoomTaskRow) ||
    !(v['nextPage'] === null || token(v['nextPage']))
  )
    return false;
  const reason = v['fenceReason'];
  return (
    (reason === null ||
      (localRuntimeRecord(reason) &&
        exact(reason, ['id', 'code']) &&
        localId(reason['id']) &&
        holds.includes(reason['code'] as null) &&
        reason['code'] !== null)) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= LOCAL_RUNTIME_MAX_FRAME - 1024
  );
}

export function isRoomTaskStopReceipt(v: unknown): v is RoomTaskStopReceipt {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    exact(v, [...scopeKeys, 'requestId', 'expectedRevision', 'revision', 'status']) &&
    localId(v['requestId']) &&
    localPosition(v['expectedRevision']) &&
    v['expectedRevision'] > 0 &&
    localPosition(v['revision']) &&
    v['revision'] === v['expectedRevision'] + 1 &&
    v['status'] === 'stopped'
  );
}
export function isRoomTaskObservation(v: unknown): v is RoomTaskObservation {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['kind', 'cursor', 'instanceId', 'view']) &&
    member(['snapshot', 'changed', 'resync', 'timeout'], v['kind']) &&
    token(v['cursor']) &&
    localId(v['instanceId']) &&
    isRoomTaskRootView(v['view'])
  );
}
