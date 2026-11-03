import {
  localId,
  localPosition,
  isLocalRoomsQuery,
  type LocalRoomsQuery,
} from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';
import { bindingDigest } from './local-runtime-decisions.js';
import { MAX_PANEL_LENGTH } from './local-coding-panel.js';
export const PROFILE_METHODS = [
  'bots.list',
  'bots.create',
  'rooms.direct',
  'rooms.group',
  'coding.show',
  'coding.diff',
  'coding.pending',
  'coding.inspect-apply',
] as const;
interface Mutation {
  workspaceId: string;
  requestId: string;
}
export interface LocalBotInput extends Mutation {
  handle: string;
  name: string;
  role: string;
  provider: string;
  model: string;
}
export interface LocalBotProfile extends Omit<LocalBotInput, 'requestId'> {
  id: string;
  profileVersion: number;
}
export interface LocalDirectInput extends Mutation {
  botId: string;
}
export interface LocalGroupInput extends Mutation {
  title: string;
  botIds: readonly string[];
}
export type LocalRoomRecord = { id: string; workspaceId: string } & (
  { kind: 'direct'; botId: string } | { kind: 'group'; title: string; botIds: readonly string[] }
);
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
const fields = ['handle', 'name', 'role', 'provider', 'model'];
const mutation = ['workspaceId', 'requestId'];
const base = (v: Record<string, unknown>) => localId(v['workspaceId']) && localId(v['requestId']);
export const isBotInput = (v: unknown): v is LocalBotInput =>
  exact(v, [...mutation, ...fields]) && base(v) && fields.every((k) => typeof v[k] === 'string');
export const isBotProfile = (v: unknown): v is LocalBotProfile =>
  exact(v, ['workspaceId', 'id', 'profileVersion', ...fields]) &&
  localId(v['id']) &&
  localId(v['workspaceId']) &&
  localPosition(v['profileVersion']) &&
  fields.every((k) => typeof v[k] === 'string');
const botIds = (v: unknown) =>
  Array.isArray(v) && v.length >= 2 && v.length <= 32 && v.every(localId);
export const isDirectInput = (v: unknown): v is LocalDirectInput =>
  exact(v, [...mutation, 'botId']) && base(v) && localId(v['botId']);
export const isGroupInput = (v: unknown): v is LocalGroupInput =>
  exact(v, [...mutation, 'title', 'botIds']) &&
  base(v) &&
  typeof v['title'] === 'string' &&
  botIds(v['botIds']);
export const isRoomRecord = (v: unknown): v is LocalRoomRecord =>
  localRuntimeRecord(v) &&
  localId(v['workspaceId']) &&
  localId(v['id']) &&
  ((exact(v, ['workspaceId', 'id', 'kind', 'botId']) &&
    v['kind'] === 'direct' &&
    localId(v['botId'])) ||
    (exact(v, ['workspaceId', 'id', 'kind', 'title', 'botIds']) &&
      v['kind'] === 'group' &&
      typeof v['title'] === 'string' &&
      botIds(v['botIds'])));
export type CodingReadMethod = 'coding.show' | 'coding.diff' | 'coding.inspect-apply';
export interface LocalCodingRead {
  workspaceId: string;
  id: string;
  roomId?: string;
}
// Existing application inspection accepts persistent application IDs up to 4096 code units.
export const localApplicationId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
export const isCodingRead = (v: unknown): v is LocalCodingRead =>
  localRuntimeRecord(v) &&
  exact(v, ['workspaceId', 'id', ...(v['roomId'] === undefined ? [] : ['roomId'])]) &&
  localId(v['workspaceId']) &&
  localApplicationId(v['id']) &&
  (v['roomId'] === undefined || localId(v['roomId']));
export function isCodingChunk(
  v: unknown,
): v is LocalCodingRead & { offset: number; version?: string } {
  if (!localRuntimeRecord(v)) return false;
  const { offset, version, ...q } = v;
  return (
    isCodingRead(q) &&
    localPosition(offset) &&
    offset <= MAX_PANEL_LENGTH &&
    (offset === 0 ? version === undefined : bindingDigest(version))
  );
}
export type LocalPendingQuery = LocalRoomsQuery & { roomId?: string };
export function isPendingQuery(v: unknown): v is LocalPendingQuery {
  if (!localRuntimeRecord(v)) return false;
  const { roomId, after, ...page } = v;
  return (
    (roomId === undefined || localId(roomId)) &&
    (after === undefined || localApplicationId(after)) &&
    isLocalRoomsQuery(page)
  );
}
export interface LocalPendingPage {
  applications: readonly { applicationId: string; outcome: 'started' | 'uncertain' }[];
  omittedPendingEffects: number;
}
