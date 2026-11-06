import {
  LOCAL_ROOM_TASKS,
  LOCAL_ADDRESSED_HISTORY,
  LOCAL_RUNTIME_MAX_WAIT_MS,
  isRoomTaskStart,
  isRoomTaskGet,
  isRoomTaskStop,
  isRoomTaskObserve,
  isRoomTaskReceipt,
  isRoomTaskRootView,
  isRoomTaskStopReceipt,
  isRoomTaskObservation,
  type LocalRuntimeIdentity,
  type RoomTaskStart,
  type RoomTaskReceipt,
  type RoomTaskGet,
  type RoomTaskRootView,
  type RoomTaskStop,
  type RoomTaskStopReceipt,
  type RoomTaskObserve,
  type RoomTaskObservation,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
export interface LocalRoomTasksClient {
  roomTaskStart(input: RoomTaskStart): Promise<RoomTaskReceipt>;
  roomTaskGet(input: RoomTaskGet): Promise<RoomTaskRootView>;
  roomTaskStop(input: RoomTaskStop): Promise<RoomTaskStopReceipt>;
  roomTaskObserve(input: RoomTaskObserve): Promise<RoomTaskObservation>;
}
export function localRoomTasksClient(
  request: (method: string, params: unknown, timeout?: number) => Promise<unknown>,
  identity: LocalRuntimeIdentity,
): LocalRoomTasksClient {
  const requireFeature = () => {
    if (
      !identity.capabilities.includes(LOCAL_ROOM_TASKS) ||
      !identity.capabilities.includes(LOCAL_ADDRESSED_HISTORY)
    )
      throw Error('client_upgrade_required');
  };
  const scoped = (
    v: { workspaceId: string; roomId: string; rootId: string },
    q: { workspaceId: string; roomId: string; rootId: string },
  ) => v.workspaceId === q.workspaceId && v.roomId === q.roomId && v.rootId === q.rootId;
  return {
    async roomTaskStart(input) {
      requireFeature();
      const q = validatedParams(input, isRoomTaskStart);
      const v = await request('roomTasks.start', q);
      if (
        !isRoomTaskReceipt(v) ||
        v.workspaceId !== q.workspaceId ||
        v.roomId !== q.roomId ||
        JSON.stringify(v.deliveries.map((d) => d.botId)) !== JSON.stringify(q.initialBotIds)
      )
        throw Error('invalid_frame');
      return v;
    },
    async roomTaskGet(input) {
      requireFeature();
      const q = validatedParams(input, isRoomTaskGet);
      let v = await request('roomTasks.get', q);
      if (!isRoomTaskRootView(v) || !scoped(v, q)) throw Error('invalid_frame');
      const first = v,
        rows = [...v.rows],
        seen = new Set<string>();
      while (v.nextPage !== null) {
        if (seen.has(v.nextPage)) throw Error('invalid_frame');
        seen.add(v.nextPage);
        v = await request('roomTasks.get', { ...q, page: v.nextPage });
        if (
          !isRoomTaskRootView(v) ||
          !scoped(v, q) ||
          v.revision !== first.revision ||
          v.status !== first.status ||
          JSON.stringify(v.counts) !== JSON.stringify(first.counts)
        )
          throw Error('invalid_frame');
        if (JSON.stringify(v.fenceReason) !== JSON.stringify(first.fenceReason) || !v.rows.length)
          throw Error('invalid_frame');
        rows.push(...v.rows);
        if (rows.length > 512) throw Error('invalid_frame');
      }
      const key = (row: RoomTaskRootView['rows'][number]) =>
        Buffer.from(
          (row.type === 'task' ? '0' : row.type === 'delivery' ? '1' : '2') +
            (row.type === 'slice' ? row.turnId : row.id),
        );
      if (rows.some((row, i) => i > 0 && Buffer.compare(key(rows[i - 1]!), key(row)) >= 0))
        throw Error('invalid_frame');
      return { ...first, rows, nextPage: null };
    },
    async roomTaskStop(input) {
      requireFeature();
      const q = validatedParams(input, isRoomTaskStop);
      const v = await request('roomTasks.stop', q, LOCAL_RUNTIME_MAX_WAIT_MS);
      if (
        !isRoomTaskStopReceipt(v) ||
        !scoped(v, q) ||
        v.requestId !== q.requestId ||
        v.expectedRevision !== q.expectedRevision
      )
        throw Error('invalid_frame');
      return v;
    },
    async roomTaskObserve(input) {
      requireFeature();
      const q = validatedParams(input, isRoomTaskObserve);
      const v = await request('roomTasks.observe', q, LOCAL_RUNTIME_MAX_WAIT_MS + 1000);
      if (!isRoomTaskObservation(v) || v.instanceId !== identity.instanceId || !scoped(v.view, q))
        throw Error('invalid_frame');
      return v;
    },
  };
}
