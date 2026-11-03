import {
  localRuntimeRecord,
  localPosition,
  localId,
  isLocalRoomsQuery,
  isLocalRoomListQuery,
  isLocalHistoryQuery,
  isLocalEventsQuery,
  isLocalObserveQuery,
  isLocalRoomObserveQuery,
  isLocalCancelRequest,
  isLocalRunQuery,
  isLocalRunSnapshot,
  type LocalRuntimeIdentity,
  type LocalRoomsQuery,
  type LocalRoomListQuery,
  type LocalHistoryQuery,
  type LocalEventsQuery,
  type LocalObserveQuery,
  type LocalRoomObserveQuery,
  type LocalRoomObservation,
  type LocalCancelRequest,
  type LocalCancelReceipt,
  type LocalRunQuery,
  type LocalRoomScope,
  type LocalObservation,
  type LocalMessage,
  type LocalRunEvent,
  type LocalMemberSummary,
  type LocalObservedRun,
  type LocalRoomSummary,
} from '@runnets/contracts';

export interface LocalRoomClient {
  listRooms(query: LocalRoomsQuery): Promise<readonly LocalRoomSummary[]>;
  listMembers(query: LocalRoomListQuery): Promise<readonly LocalMemberSummary[]>;
  history(query: LocalHistoryQuery): Promise<readonly LocalMessage[]>;
  listRuns(query: LocalRoomListQuery): Promise<readonly LocalObservedRun[]>;
  listEvents(query: LocalEventsQuery): Promise<readonly LocalRunEvent[]>;
  getResult(query: LocalRunQuery): Promise<LocalMessage | null>;
  observeRoom(query: LocalRoomObserveQuery): Promise<LocalRoomObservation>;
  observeRun(query: LocalObserveQuery): Promise<LocalObservation>;
  cancelRun(query: LocalCancelRequest): Promise<LocalCancelReceipt>;
}
export function validatedParams<T>(input: unknown, valid: (value: unknown) => value is T): T {
  if (
    !localRuntimeRecord(input) ||
    'toJSON' in input ||
    Reflect.ownKeys(input).some(
      (k) => typeof k !== 'string' || !Object.prototype.propertyIsEnumerable.call(input, k),
    )
  )
    throw Error('invalid_params');
  const snapshot = { ...input };
  if (!valid(snapshot)) throw Error('invalid_params');
  return snapshot;
}
type Row = Record<string, unknown>;
function invalid(): never {
  throw Error('invalid_frame');
}
function record(value: unknown): Row {
  return localRuntimeRecord(value) ? value : invalid();
}
function rows<T>(
  value: unknown,
  limit: number | undefined,
  decode: (row: Row, index: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length > (limit ?? 50)) invalid();
  return value.map((item, i) => decode(record(item), i));
}
function scoped(row: Row, q: LocalRoomScope) {
  return row['workspaceId'] === q.workspaceId && row['roomId'] === q.roomId;
}
function boundRun(value: unknown, q: LocalRunQuery) {
  const row = record(value);
  if (!scoped(row, q) || row['runId'] !== q.runId) invalid();
  return row;
}
function observed(row: Row, q: LocalRoomScope): LocalObservedRun {
  if (
    !scoped(row, q) ||
    !isLocalRunSnapshot(row) ||
    !Array.isArray(row['pendingDecisionIds']) ||
    row['pendingDecisionIds'].length > 200 ||
    !row['pendingDecisionIds'].every(localId)
  )
    invalid();
  return { ...row, pendingDecisionIds: row['pendingDecisionIds'] };
}
function message(row: Row, q: LocalRoomScope): LocalMessage {
  const id = row['id'],
    seq = row['seq'],
    targetBotId = row['targetBotId'],
    createdAt = row['createdAt'],
    encoded = row['bodyBase64'];
  if (
    !scoped(row, q) ||
    !localId(id) ||
    !localPosition(seq) ||
    seq < 1 ||
    !(targetBotId === null || localId(targetBotId)) ||
    typeof createdAt !== 'string' ||
    typeof encoded !== 'string'
  )
    invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 1048576 || bytes.toString('base64') !== encoded) invalid();
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const result = {
    workspaceId: q.workspaceId,
    roomId: q.roomId,
    id,
    seq,
    targetBotId,
    createdAt,
    body,
  };
  if (row['author'] === 'user' && row['turnId'] === undefined && row['authorBotId'] === undefined)
    return { ...result, author: 'user' };
  if (
    row['author'] === 'bot' &&
    localId(row['turnId']) &&
    localId(row['authorBotId']) &&
    targetBotId === row['authorBotId']
  )
    return { ...result, author: 'bot', turnId: row['turnId'], authorBotId: row['authorBotId'] };
  return invalid();
}
type Send = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
export function localRoomClient(send: Send, identity: LocalRuntimeIdentity): LocalRoomClient {
  return {
    async listRooms(input) {
      const q = validatedParams(input, isLocalRoomsQuery);
      return rows(await send('rooms.list', q), q.limit, (row) => {
        const id = row['id'],
          kind = row['kind'],
          title = row['title'],
          botId = row['botId'];
        if (
          row['workspaceId'] !== q.workspaceId ||
          !localId(id) ||
          !(
            (kind === 'direct' && localId(botId) && title === null) ||
            (kind === 'group' && botId === null && typeof title === 'string')
          )
        )
          invalid();
        return { workspaceId: q.workspaceId, id, kind, title, botId };
      });
    },
    async listMembers(input) {
      const q = validatedParams(input, isLocalRoomListQuery);
      return rows(await send('rooms.members', q), q.limit, (row) => {
        const id = row['id'],
          handle = row['handle'],
          name = row['name'],
          model = row['model'],
          provider = row['provider'];
        if (
          !scoped(row, q) ||
          !localId(id) ||
          typeof handle !== 'string' ||
          typeof model !== 'string' ||
          typeof provider !== 'string' ||
          typeof name !== 'string'
        )
          invalid();
        return { workspaceId: q.workspaceId, roomId: q.roomId, id, handle, name, provider, model };
      });
    },
    async history(input) {
      const q = validatedParams(input, isLocalHistoryQuery);
      return rows(await send('history.list', q), q.limit, (row, i) =>
        row['seq'] === (q.after ?? 0) + i + 1 ? message(row, q) : invalid(),
      );
    },
    async listRuns(input) {
      const q = validatedParams(input, isLocalRoomListQuery);
      return rows(await send('runs.list', q), q.limit, (row) => observed(row, q));
    },
    async listEvents(input) {
      const q = validatedParams(input, isLocalEventsQuery);
      return rows(boundRun(await send('runs.events', q), q)['events'], q.limit, (row, i) => {
        const sequence = row['sequence'],
          type = row['type'],
          sensitivity = row['sensitivity'];
        if (
          !localPosition(sequence) ||
          sequence !== (q.after ?? 0) + i + 1 ||
          typeof type !== 'string' ||
          !(sensitivity === 'internal' || sensitivity === 'restricted' || sensitivity === 'public')
        )
          invalid();
        return { sequence, type, sensitivity };
      });
    },
    async getResult(input) {
      const q = validatedParams(input, isLocalRunQuery);
      const result = boundRun(await send('runs.result', q), q)['message'];
      if (result === null) return null;
      const msg = message(record(result), q);
      if (msg.author !== 'bot') invalid();
      return msg;
    },
    async observeRun(input) {
      const q = validatedParams(input, isLocalObserveQuery);
      const row = record(await send('observe', q, (q.waitMs ?? 0) + 5000));
      const snapshot = observed(record(row['snapshot']), q);
      if (snapshot.runId !== q.runId) invalid();
      return { ...observation(row, q, identity), snapshot };
    },
    async observeRoom(input) {
      const q = validatedParams(input, isLocalRoomObserveQuery);
      const row = record(await send('observe', q, (q.waitMs ?? 0) + 5000));
      if ('snapshot' in row) invalid();
      return observation(row, q, identity);
    },
    async cancelRun(input) {
      const q = validatedParams(input, isLocalCancelRequest);
      const row = record(await send('runs.cancel', q));
      const version = row['version'];
      if (
        !scoped(row, q) ||
        row['runId'] !== q.runId ||
        row['requestId'] !== q.requestId ||
        row['expectedVersion'] !== q.expectedVersion ||
        row['status'] !== 'requested' ||
        !localPosition(version) ||
        version !== q.expectedVersion + 1
      )
        invalid();
      return { ...q, version, status: 'requested' };
    },
  };
}

function observation(
  row: Row,
  q: LocalRoomScope,
  identity: LocalRuntimeIdentity,
): LocalRoomObservation {
  const instanceId = row['instanceId'],
    kind = row['kind'],
    cursor = row['cursor'],
    roomSeq = row['roomSeq'];
  if (
    !scoped(row, q) ||
    instanceId !== identity.instanceId ||
    typeof cursor !== 'string' ||
    cursor.length > 512 ||
    !localPosition(roomSeq) ||
    !(kind === 'snapshot' || kind === 'changed' || kind === 'timeout' || kind === 'resync')
  )
    invalid();
  return { workspaceId: q.workspaceId, roomId: q.roomId, kind, cursor, roomSeq, instanceId };
}
