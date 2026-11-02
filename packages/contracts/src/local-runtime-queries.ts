import {
  LOCAL_RUNTIME_MAX_PAGE,
  LOCAL_RUNTIME_MAX_WAIT_MS,
  localRuntimeRecord,
} from './local-runtime.js';
import type { LocalRoomScope, LocalRunQuery, LocalRunSnapshot } from './local-runtime-turns.js';

export interface LocalPage<K> {
  readonly after?: K;
  readonly limit?: number;
}
export type LocalRoomsQuery = { readonly workspaceId: string } & LocalPage<string>;
export type LocalRoomListQuery = LocalRoomScope & LocalPage<string>;
export type LocalHistoryQuery = LocalRoomScope & LocalPage<number>;
export type LocalEventsQuery = LocalRunQuery & LocalPage<number>;
export interface LocalRoomObserveQuery extends LocalRoomScope {
  readonly cursor?: string;
  readonly waitMs?: number;
}
export type LocalObserveQuery = LocalRoomObserveQuery & LocalRunQuery;
export interface LocalCancelRequest extends LocalRunQuery {
  readonly requestId: string;
  readonly expectedVersion: number;
}
export interface LocalCancelReceipt extends LocalCancelRequest {
  readonly version: number;
  readonly status: 'requested';
}
export interface LocalRoomSummary {
  readonly workspaceId: string;
  readonly id: string;
  readonly kind: 'direct' | 'group';
  readonly title: string | null;
  readonly botId: string | null;
}
export interface LocalMemberSummary extends LocalRoomScope {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
}
export interface LocalMessage extends LocalRoomScope {
  readonly id: string;
  readonly seq: number;
  readonly author: 'user' | 'bot';
  readonly authorBotId?: string;
  readonly turnId?: string;
  readonly targetBotId: string | null;
  readonly body: string;
  readonly createdAt: string;
}
/** Base64 UTF-8 keeps even the largest valid text and its escaped controls within one wire frame. */
export type LocalWireMessage = Omit<LocalMessage, 'body'> & { readonly bodyBase64: string };
export interface LocalRunEvent {
  readonly sequence: number;
  readonly type: string;
  readonly sensitivity: 'public' | 'internal' | 'restricted';
}
export interface LocalObservedRun extends LocalRunSnapshot {
  readonly pendingDecisionIds: readonly string[];
}
export interface LocalRoomObservation extends LocalRoomScope {
  readonly kind: 'snapshot' | 'changed' | 'timeout' | 'resync';

  readonly roomSeq: number;
  readonly instanceId: string;
  readonly cursor: string;
}

export interface LocalObservation extends LocalRoomObservation {
  readonly snapshot: LocalObservedRun;
}

export const localId = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 128;
export const localPosition = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function valid(
  v: unknown,
  ids: readonly string[],
  extras: readonly string[],
): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    ids.every((k) => localId(v[k])) &&
    Object.keys(v).every((k) => ids.includes(k) || extras.includes(k))
  );
}
const ws = ['workspaceId'],
  room = [...ws, 'roomId'],
  run = [...room, 'runId'];
function page(v: unknown, ids: readonly string[], after: (value: unknown) => boolean) {
  return (
    valid(v, ids, ['after', 'limit']) &&
    (v['after'] === undefined || after(v['after'])) &&
    (v['limit'] === undefined ||
      (localPosition(v['limit']) && v['limit'] > 0 && v['limit'] <= LOCAL_RUNTIME_MAX_PAGE))
  );
}
export const isLocalRoomsQuery = (v: unknown): v is LocalRoomsQuery => page(v, ws, localId);
export const isLocalRoomListQuery = (v: unknown): v is LocalRoomListQuery => page(v, room, localId);
export const isLocalHistoryQuery = (v: unknown): v is LocalHistoryQuery =>
  page(v, room, localPosition);
export const isLocalEventsQuery = (v: unknown): v is LocalEventsQuery =>
  page(v, run, localPosition);
const observe = (v: unknown, ids: readonly string[]) =>
  valid(v, ids, ['cursor', 'waitMs']) &&
  (v['cursor'] === undefined || (typeof v['cursor'] === 'string' && v['cursor'].length <= 512)) &&
  (v['waitMs'] === undefined ||
    (localPosition(v['waitMs']) && v['waitMs'] <= LOCAL_RUNTIME_MAX_WAIT_MS));
export const isLocalObserveQuery = (v: unknown): v is LocalObserveQuery => observe(v, run);
export const isLocalRoomObserveQuery = (v: unknown): v is LocalRoomObserveQuery => observe(v, room);
export const isLocalCancelRequest = (v: unknown): v is LocalCancelRequest =>
  valid(v, [...run, 'requestId'], ['expectedVersion']) && localPosition(v['expectedVersion']);

export const LOCAL_ROOM_METHODS = [
  'rooms.list',
  'rooms.members',
  'history.list',
  'runs.list',
  'runs.events',
  'runs.result',
  'observe',
  'runs.cancel',
] as const;
export interface LocalRunEventPage extends LocalRunQuery {
  readonly events: readonly LocalRunEvent[];
}
export interface LocalRunResult extends LocalRunQuery {
  readonly message: LocalWireMessage | null;
}
