/** Frozen RC2 ordinary profile decoder from cfa8490. */
import {
  isBotInput,
  isBotProfile,
  isDirectInput,
  isGroupInput,
  isRoomRecord,
  isLocalRoomsQuery,
  isPendingQuery,
  localPosition,
  localApplicationId,
  localRuntimeRecord,
  type LocalBotInput,
  type LocalBotProfile,
  type LocalDirectInput,
  type LocalGroupInput,
  type LocalRoomRecord,
  type LocalRoomsQuery,
  type LocalPendingQuery,
  type LocalPendingPage,
} from '@runnets/contracts';
import { validatedParams } from './rc2-room-client.ts';
export interface LocalProfileClient {
  listBots(input: LocalRoomsQuery): Promise<readonly LocalBotProfile[]>;
  createBot(input: LocalBotInput): Promise<{ kind: 'bot'; data: LocalBotProfile }>;
  openDirect(input: LocalDirectInput): Promise<{ kind: 'room'; data: LocalRoomRecord }>;
  createGroup(input: LocalGroupInput): Promise<{ kind: 'room'; data: LocalRoomRecord }>;
  pendingCoding(input: LocalPendingQuery): Promise<LocalPendingPage>;
}
function invalid(): never {
  throw Error('invalid_frame');
}
export function localProfileClient(
  send: (method: string, p: unknown) => Promise<unknown>,
): LocalProfileClient {
  const room = async (method: string, q: LocalDirectInput | LocalGroupInput) => {
    const r = await send(method, q);
    if (
      !localRuntimeRecord(r) ||
      r['kind'] !== 'room' ||
      !isRoomRecord(r['data']) ||
      r['data'].workspaceId !== q.workspaceId
    )
      return invalid();
    const data = r['data'];
    if (
      'botId' in q
        ? data.kind !== 'direct' || data.botId !== q.botId
        : data.kind !== 'group' ||
          data.title !== q.title ||
          JSON.stringify([...q.botIds].sort()) !== JSON.stringify(data.botIds)
    )
      return invalid();
    return { kind: 'room' as const, data };
  };
  return {
    async createBot(input) {
      const q = validatedParams(input, isBotInput),
        r = await send('bots.create', q);
      if (!localRuntimeRecord(r) || r['kind'] !== 'bot' || !isBotProfile(r['data']))
        return invalid();
      const data = r['data'];
      if (
        (['workspaceId', 'handle', 'role', 'model', 'name', 'provider'] as const).some(
          (k) => data[k] !== q[k],
        )
      )
        return invalid();
      return { kind: 'bot', data };
    },
    async listBots(input) {
      const q = validatedParams(input, isLocalRoomsQuery),
        rows = await send('bots.list', q);
      if (!Array.isArray(rows) || rows.length > (q.limit ?? 50)) return invalid();
      return rows.map((r) => (isBotProfile(r) && r.workspaceId === q.workspaceId ? r : invalid()));
    },
    openDirect: async (input) => room('rooms.direct', validatedParams(input, isDirectInput)),
    createGroup: async (input) => {
      const q = validatedParams(input, isGroupInput);
      return room('rooms.group', { ...q, botIds: [...q.botIds] });
    },
    async pendingCoding(input) {
      const q = validatedParams(input, isPendingQuery),
        r = await send('coding.pending', q);
      if (
        !localRuntimeRecord(r) ||
        r['workspaceId'] !== q.workspaceId ||
        r['roomId'] !== (q.roomId ?? null) ||
        !Array.isArray(r['applications']) ||
        r['applications'].length > (q.limit ?? 50) ||
        !localPosition(r['omittedPendingEffects'])
      )
        return invalid();
      return {
        omittedPendingEffects: r['omittedPendingEffects'],
        applications: r['applications'].map((a: unknown) =>
          localRuntimeRecord(a) &&
          localApplicationId(a['applicationId']) &&
          (a['outcome'] === 'started' || a['outcome'] === 'uncertain')
            ? { applicationId: a['applicationId'], outcome: a['outcome'] }
            : invalid(),
        ),
      };
    },
  };
}
