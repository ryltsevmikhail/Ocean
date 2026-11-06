import { completionSummary, stepCommand } from './commands.js';
import { roomHandoffCommand, roomCompleteEvidence } from './room-slice-handoff.js';
import {
  canonicalJson,
  taskRunId,
  roomAgentBinding,
  type ChatTurn,
  type TaskRunId,
  type ConversationMessage,
} from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import type { RoomDeliveryRecord, RoomTaskBot, RoomTaskRoot } from './room-task-records.js';
import { roomTaskReceipt } from './room-task-receipt.js';
export { roomSliceAuthority } from './room-task-authority.js';
/** Stored receipts and joins establish meaning; delivery IDs select, never authorize. */
export function inputEvidence(
  tx: Pick<
    ConversationTransaction,
    'roomTasks' | 'receipt' | 'history' | 'chatTurn' | 'chatFailureEvidence'
  >,
  d: RoomDeliveryRecord,
  task: RoomTaskBot,
  root: RoomTaskRoot,
  historical = false,
): { message: ConversationMessage; parent: TaskRunId | null } | null {
  const rt = tx.roomTasks!,
    receipt = tx.receipt(d.requestKey);
  const message = tx.history(d.roomId, d.seq - 1, 1)[0];
  if (
    !receipt ||
    receipt.reply.kind !== 'message' ||
    !message ||
    message.id !== d.messageId ||
    message.workspaceId !== d.workspaceId ||
    canonicalJson(message) !== canonicalJson(receipt.reply.data) ||
    task.rootId !== root.id ||
    task.assigneeBotId !== d.recipientBotId ||
    ![root, task].every((v) => v.roomId === d.roomId && v.workspaceId === d.workspaceId)
  )
    return null;
  if (d.kind === 'start') {
    const rows = rt.deliveriesForReceipt(d.requestKey, message.id);
    const binding = canonicalJson([
      'RoomTaskStart/v1',
      root.rootPayload.ownerId,
      root.workspaceId,
      root.roomId,
      message.body,
      rows.map((r) => r.recipientBotId),
      root.rootPayload.members.map((m) => ({ botId: m.botId, grantReferences: m.grantReferences })),
      root.rootPayload.mandate,
    ]);
    if (
      !roomTaskReceipt(tx, d.requestKey, receipt, binding, {
        workspaceId: d.workspaceId,
        roomId: d.roomId,
        author: 'user',
        body: message.body,
        targetBotId: message.targetBotId,
      }) ||
      d.causeId !== root.id ||
      task.parentId !== root.id
    )
      return null;
    return { message, parent: null };
  }
  const source = d.sourceTurnId && tx.chatTurn(d.sourceTurnId);
  if (
    !source ||
    !d.sourceAttemptId ||
    source.bot.id !== d.senderBotId ||
    source.roomId !== d.roomId ||
    source.workspaceId !== d.workspaceId
  )
    return null;
  if (d.kind === 'result') {
    const edge = rt.delivery(d.causeId),
      child = d.fromTaskId && rt.task(d.fromTaskId);
    const yielded = edge?.sourceTurnId && tx.chatTurn(edge.sourceTurnId);
    if (
      !edge ||
      edge.kind !== 'delegate' ||
      !child ||
      child.kind !== 'bot' ||
      child.status !== 'completed' ||
      edge.fromTaskId !== task.id ||
      edge.toTaskId !== child.id ||
      child.parentId !== task.id ||
      !yielded ||
      yielded.roomSliceDisposition !== 'yielded' ||
      yielded.roomHandoff?.deliveryId !== edge.id ||
      source.status !== 'completed' ||
      source.roomSliceDisposition !== undefined ||
      source.roomDelivery?.taskId !== child.id ||
      message.id !== 'reply_' + source.id ||
      message.turnId !== source.id ||
      message.authorBotId !== child.assigneeBotId ||
      message.targetBotId !== child.assigneeBotId ||
      message.body !== source.text ||
      (!historical && task.waitingChildId !== null) ||
      !inputEvidence(tx, edge, child, root, true) ||
      receipt.binding !== resultBinding(edge, d, source, message)
    )
      return null;
    const command = stepCommand(
      taskRunId(source.taskRunId),
      'Complete',
      { attemptId: d.sourceAttemptId, summary: completionSummary(source.text) },
      source.preparedVersion!,
    );
    const completion = rt.completeEvidence(command);
    const effects = tx.chatFailureEvidence?.(source.taskRunId);
    if (
      !completion ||
      !roomCompleteEvidence(completion, command) ||
      !effects ||
      effects.taskVersion !== completion.run.version ||
      effects.relatedPendingEffects !== 0
    )
      return null;
    return { message, parent: taskRunId(yielded.taskRunId) };
  }
  const facts = rt.origin(source.id, source.taskRunId, d.sourceAttemptId, false);
  if (
    !facts ||
    d.fromTaskId !== facts.task.id ||
    d.causeId !== facts.input.id ||
    task.parentId !== facts.task.id
  )
    return null;
  const binding = roomAgentBinding(
    {
      task: {
        ...facts.task,
        members: root.rootPayload.members.map((m) => m.botId),
        grantReferences: root.rootPayload.members.find((m) => m.botId === source.bot.id)!
          .grantReferences,
      },
      botId: source.bot.id,
      turnId: source.id,
      deliveryId: facts.input.id,
      attemptId: d.sourceAttemptId,
      callId: source.roomHandoff?.callId ?? '',
    },
    { kind: d.kind, toBotId: task.assigneeBotId, text: message.body },
  );
  if (receipt.binding !== binding) return null;
  if (
    d.kind === 'delegate' &&
    (source.roomHandoff?.attemptId !== d.sourceAttemptId ||
      source.roomSliceDisposition !== 'yielded' ||
      source.roomHandoff?.deliveryId !== d.id ||
      source.roomHandoff.childTaskId !== task.id ||
      facts.input.state !== 'consumed' ||
      (!historical && (facts.task.status !== 'waiting' || facts.task.waitingChildId !== task.id)))
  )
    return null;
  if (d.kind === 'message') {
    const origin = rt.origin(
      source.id,
      source.taskRunId,
      d.sourceAttemptId,
      historical ? 'historical' : 'settled',
    );
    const effects = tx.chatFailureEvidence?.(source.taskRunId);
    if (
      !origin?.liveRun ||
      !effects ||
      effects.taskVersion !== origin.liveRun.version ||
      effects.relatedPendingEffects !== 0
    )
      return null;
  }
  if (d.kind === 'delegate') {
    const command = roomHandoffCommand(source.roomHandoff!);
    const completion = rt.completeEvidence(command),
      effects = tx.chatFailureEvidence?.(source.taskRunId);
    if (
      !completion ||
      !roomCompleteEvidence(completion, command) ||
      !effects ||
      effects.taskVersion !== completion.run.version ||
      effects.relatedPendingEffects !== 0
    )
      return null;
  }
  if (
    !roomTaskReceipt(tx, d.requestKey, receipt, receipt.binding, {
      workspaceId: d.workspaceId,
      roomId: d.roomId,
      author: 'bot',
      authorBotId: d.senderBotId,
      targetBotId: d.recipientBotId,
      turnId: source.id,
      body: message.body,
    })
  )
    return null;
  return { message, parent: taskRunId(source.taskRunId) };
}
export function resultBinding(
  edge: RoomDeliveryRecord,
  result: RoomDeliveryRecord,
  turn: ChatTurn,
  final: ConversationMessage,
): string {
  return canonicalJson([
    'RoomResult/v1',
    edge.id,
    edge.rootId,
    edge.fromTaskId,
    edge.toTaskId,
    turn.id,
    turn.taskRunId,
    result.sourceAttemptId,
    final,
  ]);
}
