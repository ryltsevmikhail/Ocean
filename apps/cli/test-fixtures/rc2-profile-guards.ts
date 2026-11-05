/** Pinned RC2 profile validators, 5e10ec32179063be78a55f6835866a1a864991ac: local-profile.ts.
 * Runtime bodies copied from that revision; only unused coding-panel guards are omitted.
 */
import type {
  LocalBotInput,
  LocalBotProfile,
  LocalDirectInput,
  LocalGroupInput,
  LocalRoomRecord,
  LocalPendingQuery,
} from '@runnets/contracts';
import { localRuntimeRecord } from './rc2-wire-primitives.ts';
import { localId, localPosition, isLocalRoomsQuery } from './rc2-query-contract.ts';
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
export const localApplicationId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
export function isPendingQuery(v: unknown): v is LocalPendingQuery {
  if (!localRuntimeRecord(v)) return false;
  const { roomId, after, ...page } = v;
  return (
    (roomId === undefined || localId(roomId)) &&
    (after === undefined || localApplicationId(after)) &&
    isLocalRoomsQuery(page)
  );
}
