import { canonicalJson } from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
export interface RoomTaskScope {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly rootId: string;
}
export type RoomTaskStop = RoomTaskScope & {
  readonly requestId: string;
  readonly expectedRevision: number;
};
export type RoomTaskStopReceipt = RoomTaskStop & {
  readonly revision: number;
  readonly status: 'stopped';
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

export function stopRoomTask(
  store: ConversationStore,
  ownerId: string,
  input: RoomTaskStop,
): RoomTaskStopReceipt {
  return store.atomic((tx) => {
    const binding = canonicalJson(['RoomTaskStop/v1', ownerId, input]);
    const prior = tx.receipt(input.requestId);
    if (prior) {
      if (
        prior.binding !== binding ||
        prior.reply.kind !== 'room_task_stop' ||
        canonicalJson(prior.reply.data) !==
          canonicalJson({ ...input, revision: input.expectedRevision + 1, status: 'stopped' })
      )
        throw Error('request_conflict');
      return prior.reply.data;
    }
    const rt = tx.roomTasks,
      root = rt?.task(input.rootId);
    if (
      !rt ||
      !root ||
      root.kind !== 'root' ||
      root.workspaceId !== input.workspaceId ||
      root.roomId !== input.roomId ||
      root.rootPayload.ownerId !== ownerId
    )
      throw Error('unknown_root');
    if (!root.hostScope || canonicalJson(root.hostScope) !== canonicalJson(rt.hostScope()))
      throw Error('recovery_required');
    if (root.revision !== input.expectedRevision || !['ready', 'paused'].includes(root.status))
      throw Error('revision_conflict');
    const receipt: RoomTaskStopReceipt = {
      ...input,
      revision: root.revision + 1,
      status: 'stopped',
    };
    rt.advanceTask({ ...root, status: 'stopped' }, root.revision);
    tx.putReceipt(input.requestId, { binding, reply: { kind: 'room_task_stop', data: receipt } });
    return receipt;
  });
}

export interface RoomTaskFenceReceipt extends RoomTaskScope {
  readonly id: string;
  readonly code: Exclude<RoomTaskHold, null>;
  readonly revision: number;
}
export interface RoomTaskStateReceipt extends RoomTaskScope {
  readonly taskId: string;
  readonly status: RoomTaskStatus;
  readonly slices: readonly Extract<RoomTaskRow, { type: 'slice' }>[];
}

import { roomAgentRequestKey, validConversationText } from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import type { RoomTaskRoot, RoomTaskActor } from './room-task-records.js';
import type { RoomTaskPersistenceDeps } from './room-task-persistence.js';
import { admitRoomCount, roomSliceAuthority } from './room-task-authority.js';
import { inputEvidence } from './room-delivery-evidence.js';
export function freezeRoomTask(
  tx: ConversationTransaction,
  root: RoomTaskRoot,
  code: Exclude<RoomTaskHold, null>,
  sha256: (s: string) => string,
): void {
  const id = 'room-fence/v1:' + sha256(root.id);
  if (tx.receipt(id)) return;
  if (root.status !== 'ready') return;
  const receipt = {
    workspaceId: root.workspaceId,
    roomId: root.roomId,
    rootId: root.id,
    id,
    code,
    revision: root.revision + 1,
  };
  tx.roomTasks!.advanceTask({ ...root, status: 'paused' }, root.revision);
  tx.putReceipt(id, {
    binding: canonicalJson(['RoomTaskFence/v1', root.id, code]),
    reply: { kind: 'room_task_fence', data: receipt },
  });
}
export function roomTaskState(
  d: RoomTaskPersistenceDeps,
  actor: RoomTaskActor,
  targetId: string,
): { reply: RoomTaskStateReceipt; fresh: boolean } | { error: 'tool_limit' } {
  if (!validConversationText(targetId, 128)) throw Error('invalid_input');
  const key =
    'room-agent/v1:' + d.sha256(roomAgentRequestKey(actor.turnId, actor.attemptId, actor.callId));
  return d.store.atomic((tx) => {
    const rt = tx.roomTasks,
      prior = tx.receipt(key);
    const facts = rt?.origin(actor.turnId, actor.taskRunId, actor.attemptId, prior ? false : true);
    if (!rt || !facts || facts.root.rootPayload.ownerId !== d.ownerId)
      throw Error('authority_denied');
    const binding = canonicalJson([
      'RoomTaskState/v1',
      actor,
      facts.root.workspaceId,
      facts.root.roomId,
      facts.root.id,
      targetId,
    ]);
    if (prior) {
      if (prior.binding !== binding || prior.reply.kind !== 'room_task_state')
        throw Error('request_conflict');
      return { reply: prior.reply.data, fresh: false };
    }
    if (
      !roomSliceAuthority(tx, facts.root, facts.task, d.clock.now().getTime(), d.sha256) ||
      !facts.turn.activation ||
      d.clock.now().getTime() >= Date.parse(facts.turn.activation.deadlineAt)
    )
      throw Error('authority_denied');
    const prefix =
      actor.attemptId + '_r' + facts.liveRun!.modelExecution!.lastRequest.ordinal + '_';
    const effects = tx.chatFailureEvidence?.(actor.taskRunId);
    if (
      !actor.callId.startsWith(prefix) ||
      actor.callId.length <= prefix.length ||
      !effects ||
      effects.taskVersion !== facts.liveRun!.version ||
      effects.relatedPendingEffects !== 0
    )
      throw Error('authority_denied');
    const target = rt.task(targetId);
    if (
      !target ||
      target.rootId !== facts.root.id ||
      target.workspaceId !== facts.root.workspaceId ||
      target.roomId !== facts.root.roomId
    )
      throw Error('authority_denied');
    const ancestor = (from: string, to: string) => {
      const seen = new Set<string>();
      for (
        let current = rt.task(from);
        current && !seen.has(current.id);
        current = current.parentId ? rt.task(current.parentId) : null
      ) {
        if (current.id === to) return true;
        seen.add(current.id);
        if (current.kind !== 'bot') return false;
        const edge = rt.inputs(current.id).find((e) => e.kind !== 'result');
        if (!edge || !inputEvidence(tx, edge, current, facts.root, true)) return false;
      }
      return false;
    };
    if (!ancestor(target.id, facts.task.id) && !ancestor(facts.task.id, target.id))
      throw Error('authority_denied');
    if (!admitRoomCount(rt.counts(facts.root.id), 'tool_calls')) {
      freezeRoomTask(tx, facts.root, 'tool_limit', d.sha256);
      return { error: 'tool_limit' };
    }
    const view = rt.projection(facts.root.id)!;
    const slices = view.rows.filter(
      (r): r is Extract<RoomTaskRow, { type: 'slice' }> =>
        r.type === 'slice' && r.taskId === target.id,
    );
    const reply = {
      workspaceId: facts.root.workspaceId,
      roomId: facts.root.roomId,
      rootId: facts.root.id,
      taskId: target.id,
      status: target.status,
      slices,
    };
    tx.putReceipt(key, { binding, reply: { kind: 'room_task_state', data: reply } });
    return { reply, fresh: true };
  });
}
