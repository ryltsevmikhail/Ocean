import { roomCodingTask } from './room-task-coding.js';
export { roomCodingTask } from './room-task-coding.js';
import type { OwnerScopeGrant } from '@runnets/domain';
import { canonicalJson, ownerGrantApplies } from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import type { RoomTaskRoot, RoomTaskBot } from './room-task-records.js';
import { roomTaskIdentity } from './room-task-identity.js';
import { admitRoomModelTransfer } from './room-model-policy.js';
export type RoomAuthorityRead = Pick<
  ConversationTransaction,
  | 'receipt'
  | 'history'
  | 'chatTurn'
  | 'chatFailureEvidence'
  | 'roomTasks'
  | 'room'
  | 'bot'
  | 'workspace'
  | 'modelBinding'
  | 'roomPolicy'
  | 'roomModelPolicy'
  | 'activeChatTurn'
  | 'broadcastBatchForRoom'
>;
/** Shared current host/room gate; settled local calls retain their recorded sender identity. */
function currentRoomScope(
  tx: RoomAuthorityRead,
  root: RoomTaskRoot,
  task: RoomTaskBot,
  sha256?: (text: string) => string,
): boolean {
  const rt = tx.roomTasks,
    room = tx.room(task.roomId),
    bot = tx.bot(task.assigneeBotId);
  if (
    !rt ||
    !root.hostScope ||
    canonicalJson(rt.hostScope()) !== canonicalJson(root.hostScope) ||
    (rt.restored() && root.hostScope.epochId === null) ||
    tx.roomPolicy(task.roomId)?.mode === 'text_only' ||
    !room ||
    !bot ||
    !(room.kind === 'direct' ? [room.botId] : room.botIds).includes(task.assigneeBotId) ||
    root.workspaceId !== task.workspaceId ||
    root.roomId !== task.roomId ||
    tx.workspace()?.id !== root.workspaceId ||
    (root.rootPayload.mandate.codingTaskId !== null && !roomCodingTask(tx, root, sha256)) ||
    tx.activeChatTurn(task.roomId) ||
    tx.broadcastBatchForRoom(task.roomId)
  )
    return false;
  return true;
}
export function roomLocalAuthority(
  tx: RoomAuthorityRead,
  root: RoomTaskRoot,
  task: RoomTaskBot,
  sha256?: (text: string) => string,
): boolean {
  return root.status === 'ready' && currentRoomScope(tx, root, task, sha256);
}
/** New model and physical authority also require current recipient and issuing ancestor pins/refs. */
export function roomSliceAuthority(
  tx: RoomAuthorityRead,
  root: RoomTaskRoot,
  task: RoomTaskBot,
  at: number,
  sha256?: (text: string) => string,
  publication = false,
): boolean {
  return (
    (publication
      ? !!tx.roomTasks &&
        !!root.hostScope &&
        canonicalJson(tx.roomTasks.hostScope()) === canonicalJson(root.hostScope) &&
        !(tx.roomTasks.restored() && root.hostScope.epochId === null) &&
        tx.roomPolicy(root.roomId)?.mode !== 'text_only' &&
        tx.workspace()?.id === root.workspaceId
      : currentRoomScope(tx, root, task, sha256)) &&
    (publication
      ? ['ready', 'paused', 'stopped'].includes(root.status)
      : root.status === 'ready') &&
    (publication
      ? historicalRoomAssignments(tx, root, task)
      : roomTaskSubjects(tx, root, task, at, sha256) !== null)
  );
}

import { createBudget, reserve, settle, unlimitedBudget } from '@runnets/domain';
import type { RoomTaskRootView } from './room-task-host.js';
/** Pure reserve/settle over the count snapshot held by the actual admission transaction. */
export function admitRoomCount(
  counts: RoomTaskRootView['counts'],
  dimension: 'child_runs' | 'tool_calls',
): boolean {
  const budget = createBudget({ ...unlimitedBudget(), child_runs: 32, tool_calls: 64 });
  const current = {
    ...budget,
    consumed: { ...budget.consumed, child_runs: counts.slices, tool_calls: counts.toolCalls },
  };
  const reserved = reserve(current, dimension, 1);
  return reserved.ok && settle(reserved.value, dimension, 1).ok;
}

export function roomTaskSubjects(
  tx: RoomAuthorityRead,
  root: RoomTaskRoot,
  task: RoomTaskBot,
  at: number,
  sha256?: (text: string) => string,
  executorRunId: string | null = null,
):
  | readonly {
      subject: OwnerScopeGrant['subject'];
      refs: RoomTaskRoot['rootPayload']['members'][number]['grantReferences'];
      chargedRunId: string | null;
    }[]
  | null {
  const rt = tx.roomTasks,
    room = tx.room(root.roomId),
    ws = tx.workspace();
  if (!rt || !room || ws?.id !== root.workspaceId) return null;
  const members = room.kind === 'direct' ? [room.botId] : room.botIds;
  const subjects = [];
  const visited = new Set<string>();
  let current = task,
    chargedRunId = executorRunId;
  for (;;) {
    if (
      visited.has(current.id) ||
      current.workspaceId !== root.workspaceId ||
      current.roomId !== root.roomId ||
      current.rootId !== root.id
    )
      return null;
    visited.add(current.id);
    const bot = tx.bot(current.assigneeBotId),
      pin = root.rootPayload.members.find((m) => m.botId === current.assigneeBotId);
    if (
      !bot ||
      !pin ||
      !members.includes(bot.id) ||
      canonicalJson(roomTaskIdentity(tx, bot)) !== canonicalJson(pin.identity) ||
      !admitRoomModelTransfer(tx, room.id, pin.identity).ok
    )
      return null;
    const coding = roomCodingTask(tx, root, sha256);
    const subject = {
      workspaceId: root.workspaceId,
      roomId: root.roomId,
      botId: bot.id,
      projectId:
        root.rootPayload.mandate.projectId ?? sha256?.(coding?.task.projectRoot ?? ws.root) ?? null,
      taskId: coding?.task.devBotId === bot.id ? coding.task.id : null,
    };
    if (
      !pin.grantReferences.every((ref) => {
        const grant = rt.grant(ref.grantId);
        return (
          grant !== null &&
          grant.revision === ref.revision &&
          grant.owner.ownerId === root.rootPayload.ownerId &&
          ownerGrantApplies(grant, subject, at)
        );
      })
    )
      return null;
    subjects.push({ subject, refs: pin.grantReferences, chargedRunId });
    const edge = rt.inputs(current.id).find((v) => v.kind !== 'result');
    if (
      !edge ||
      edge.toTaskId !== current.id ||
      edge.rootId !== root.id ||
      edge.roomId !== root.roomId ||
      edge.workspaceId !== root.workspaceId ||
      !inputEvidence(tx, edge, current, root, true)
    )
      return null;
    if (current.parentId === root.id)
      return edge.kind === 'start' && edge.fromTaskId === null && edge.causeId === root.id
        ? subjects
        : null;
    if (
      (edge.kind !== 'delegate' && edge.kind !== 'message') ||
      edge.fromTaskId !== current.parentId ||
      !edge.sourceTurnId ||
      !edge.sourceAttemptId
    )
      return null;
    const parent = rt.task(current.parentId);
    if (!parent || parent.kind !== 'bot') return null;
    const source = rt.sourceTurn(edge.sourceTurnId);
    const origin = source && rt.origin(source.id, source.taskRunId, edge.sourceAttemptId, false);
    if (
      !origin ||
      origin.task.id !== parent.id ||
      origin.input.id !== edge.causeId ||
      origin.root.id !== root.id ||
      origin.turn.bot.id !== parent.assigneeBotId ||
      edge.senderBotId !== parent.assigneeBotId ||
      (edge.kind === 'delegate' &&
        (origin.turn.roomHandoff?.deliveryId !== edge.id ||
          origin.turn.roomHandoff.childTaskId !== current.id ||
          origin.turn.roomSliceDisposition !== 'yielded'))
    )
      return null;
    current = parent;
    chargedRunId = origin.turn.taskRunId;
  }
}

function historicalRoomAssignments(
  tx: RoomAuthorityRead,
  root: RoomTaskRoot,
  task: RoomTaskBot,
): boolean {
  const seen = new Set<string>();
  let current = task;
  for (;;) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    const edge = tx.roomTasks!.inputs(current.id).find((d) => d.kind !== 'result');
    if (!edge || !inputEvidence(tx, edge, current, root, true)) return false;
    if (current.parentId === root.id) return edge.kind === 'start';
    const parent = tx.roomTasks!.task(current.parentId);
    if (!parent || parent.kind !== 'bot' || edge.fromTaskId !== parent.id) return false;
    current = parent;
  }
}

import type { ConversationTransaction as FullRoomRead } from './conversation-ports.js';
import type { RoomAgentRequest } from '@runnets/domain';
import { inputEvidence } from './room-delivery-evidence.js';
/** Only the proved inverse result of the original pair resets the duplicate window. */
export function repeatedRoomExchange(
  tx: FullRoomRead,
  root: RoomTaskRoot,
  senderBotId: string,
  request: RoomAgentRequest,
): boolean {
  const rt = tx.roomTasks!,
    rows = rt.tasks(root.id).flatMap((t) => (t.kind === 'bot' ? rt.inputs(t.id) : []));
  let after = 0;
  for (const result of rows.filter((d) => d.kind === 'result')) {
    const edge = rt.delivery(result.causeId),
      parent = rt.task(result.toTaskId);
    if (
      edge?.kind === 'delegate' &&
      edge.senderBotId === senderBotId &&
      edge.recipientBotId === request.toBotId &&
      parent?.kind === 'bot' &&
      inputEvidence(tx, result, parent, root, true)
    )
      after = Math.max(after, result.seq);
  }
  const normalized = request.text.trim().normalize('NFC');
  return (
    rows.filter((d) => {
      if (
        d.seq <= after ||
        d.kind !== request.kind ||
        d.senderBotId !== senderBotId ||
        d.recipientBotId !== request.toBotId
      )
        return false;
      const message = tx.history(root.roomId, d.seq - 1, 1)[0],
        receipt = tx.receipt(d.requestKey);
      return (
        !!message &&
        message.id === d.messageId &&
        receipt?.reply.kind === 'message' &&
        canonicalJson(receipt.reply.data) === canonicalJson(message) &&
        message.body.trim().normalize('NFC') === normalized
      );
    }).length >= 2
  );
}

export interface RoomPhysicalScope {
  readonly codingTaskId: string | null;
  readonly turnId: string;
  readonly attemptId: string | null;
  readonly ordinal: number;
  readonly root: RoomTaskRoot;
  readonly subjects: NonNullable<ReturnType<typeof roomTaskSubjects>>;
  readonly reviewer: boolean;
}
