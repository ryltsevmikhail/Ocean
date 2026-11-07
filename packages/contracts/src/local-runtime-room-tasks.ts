import type { OwnerGrantReference, OwnerPermission } from '@runnets/domain';
export const LOCAL_ROOM_TASKS = 'room.tasks-v1';
export const LOCAL_ROOM_TASK_METHODS = [
  'roomTasks.start',
  'roomTasks.get',
  'roomTasks.stop',
  'roomTasks.observe',
] as const;
export interface RoomTaskScope {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly rootId: string;
}
export interface RoomTaskStart {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly text: string;
  readonly initialBotIds: readonly string[];
  readonly participants: readonly {
    readonly botId: string;
    readonly grantReferences: readonly OwnerGrantReference[];
  }[];
  readonly mandate: {
    readonly projectId: string | null;
    readonly codingTaskId: string | null;
    readonly permissions: readonly OwnerPermission[];
  };
}
export interface RoomTaskReceipt extends RoomTaskScope {
  readonly version: 1;
  readonly messageId: string;
  readonly seq: number;
  readonly deliveries: readonly {
    readonly botId: string;
    readonly taskId: string;
    readonly deliveryId: string;
  }[];
}
export type RoomTaskGet = RoomTaskScope & { readonly page?: string };
export type RoomTaskStop = RoomTaskScope & {
  readonly requestId: string;
  readonly expectedRevision: number;
};
export type RoomTaskStopReceipt = RoomTaskStop & {
  readonly revision: number;
  readonly status: 'stopped';
};
export type RoomTaskObserve = RoomTaskScope & {
  readonly cursor?: string;
  readonly waitMs?: number;
};
export type RoomTaskStatus = 'ready' | 'waiting' | 'paused' | 'completed' | 'stopped';
export type RoomTaskHold =
  | null
  | 'queued'
  | 'waiting'
  | 'stopped'
  | 'paused'
  | 'unknown'
  | 'authority_denied'
  | 'slice_limit'
  | 'model_limit'
  | 'tool_limit'
  | 'duplicate_exchange';
export type RoomTaskRow = { readonly hold: RoomTaskHold } & (
  | {
      readonly type: 'task';
      readonly id: string;
      readonly parentId: string | null;
      readonly botId: string | null;
      readonly status: RoomTaskStatus;
      readonly waitingChildId: string | null;
    }
  | {
      readonly type: 'delivery';
      readonly id: string;
      readonly kind: 'start' | 'message' | 'delegate' | 'result';
      readonly fromTaskId: string | null;
      readonly toTaskId: string;
      readonly causeId: string;
      readonly state: 'queued' | 'claimed' | 'consumed' | 'held';
      readonly messageId: string;
      readonly seq: number;
    }
  | {
      readonly type: 'slice';
      readonly taskId: string;
      readonly deliveryId: string;
      readonly runId: string;
      readonly turnId: string;
      readonly turnStatus: string;
      readonly taskStatus: string;
      readonly version: number;
      readonly disposition: 'yielded' | null;
      readonly resultMessageId: string | null;
      readonly pendingDecisionIds: readonly string[];
    }
);
export interface RoomTaskRootView extends RoomTaskScope {
  readonly status: RoomTaskStatus;
  readonly revision: number;
  readonly fenceReason: { readonly id: string; readonly code: Exclude<RoomTaskHold, null> } | null;
  readonly counts: {
    readonly active: number;
    readonly slices: number;
    readonly modelStarts: number;
    readonly toolCalls: number;
  };
  readonly rows: readonly RoomTaskRow[];
  readonly nextPage: string | null;
}
export interface RoomTaskObservation {
  readonly kind: 'snapshot' | 'changed' | 'resync' | 'timeout';
  readonly cursor: string;
  readonly instanceId: string;
  readonly view: RoomTaskRootView;
}

export * from './local-runtime-room-task-codecs.js';
export * from './local-runtime-room-task-list.js';
