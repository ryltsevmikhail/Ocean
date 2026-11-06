import { chatFinalMessage } from './direct-chat-publication.js';
import { canonicalJson, roomAgentRequestKey, taskRunId, type ChatTurn } from '@runnets/domain';
import type { ConversationStore, ConversationTransaction } from './conversation-ports.js';
import type { Clock } from './ports.js';
import type { TaskRunService } from './service.js';
import { completionSummary, stepCommand } from './commands.js';
import { roomCompleteEvidence, roomHandoffCommand } from './room-slice-handoff.js';
import { inputEvidence, roomSliceAuthority } from './room-delivery-evidence.js';
import {
  publishedRoomResult,
  roomAssignmentReturnReady,
  returnResult,
} from './room-slice-result.js';
export interface RoomSlicePublicationDeps {
  readonly store: ConversationStore;
  readonly tasks: TaskRunService;
  readonly clock: Clock;
  readonly sha256?: (text: string) => string;
}
/** Full joins and command evidence are read again inside every publication write lock. */
function inspect(tx: ConversationTransaction, id: string, sha256?: (text: string) => string) {
  const turn = tx.chatTurn(id),
    rt = tx.roomTasks;
  if (!turn?.roomDelivery || !rt || turn.continuationReviewId !== undefined) return null;
  const input = rt.delivery(turn.roomDelivery.deliveryId),
    task = rt.task(turn.roomDelivery.taskId);
  const root = input && rt.task(input.rootId);
  if (
    !input ||
    !task ||
    task.kind !== 'bot' ||
    !root ||
    root.kind !== 'root' ||
    task.rootId !== root.id ||
    input.toTaskId !== task.id ||
    input.recipientBotId !== turn.bot.id ||
    task.assigneeBotId !== turn.bot.id ||
    turn.inboundMessageId !== input.messageId ||
    turn.readThroughSeq !== input.seq ||
    ![input, task, root].every(
      (v) => v.roomId === turn.roomId && v.workspaceId === turn.workspaceId,
    )
  )
    return null;
  if (!inputEvidence(tx, input, task, root, true)) return null;
  const p = turn.roomHandoff;
  let attemptId: string;
  if (p) {
    const edge = rt.delivery(p.deliveryId),
      child = rt.task(p.childTaskId),
      receipt = edge && tx.receipt(edge.requestKey);
    if (
      p.turnId !== id ||
      p.taskRunId !== turn.taskRunId ||
      !edge ||
      !child ||
      child.kind !== 'bot' ||
      !receipt ||
      edge.kind !== 'delegate' ||
      edge.fromTaskId !== task.id ||
      edge.toTaskId !== child.id ||
      child.parentId !== task.id ||
      child.rootId !== root.id ||
      edge.causeId !== input.id ||
      edge.sourceTurnId !== turn.id ||
      edge.sourceAttemptId !== p.attemptId ||
      edge.senderBotId !== turn.bot.id ||
      edge.recipientBotId !== child.assigneeBotId ||
      receipt.reply.kind !== 'message'
    )
      return null;
    const sent = tx.history(turn.roomId, edge.seq - 1, 1)[0];
    if (
      !sent ||
      canonicalJson(receipt.reply.data) !== canonicalJson(sent) ||
      sent.id !== edge.messageId ||
      sent.authorBotId !== turn.bot.id ||
      sent.targetBotId !== child.assigneeBotId ||
      sent.turnId !== turn.id ||
      receipt.binding !==
        canonicalJson([
          task.workspaceId,
          task.roomId,
          root.id,
          task.id,
          input.id,
          turn.bot.id,
          'delegate',
          child.assigneeBotId,
          sent.body,
        ])
    )
      return null;
    if (
      !sha256 ||
      edge.requestKey !==
        'room-agent/v1:' + sha256(roomAgentRequestKey(p.turnId, p.attemptId, p.callId))
    )
      return null;
    attemptId = p.attemptId;
  } else {
    if (!['prepared', 'completed'].includes(turn.status) || turn.preparedVersion === null)
      return null;
    // Complete evidence validates this attempt against the actual replayed settlement.
    attemptId = `${turn.taskRunId}_at_0001`;
  }
  const command = p
    ? roomHandoffCommand(p)
    : stepCommand(
        taskRunId(turn.taskRunId),
        'Complete',
        { attemptId, summary: completionSummary(turn.text) },
        turn.preparedVersion!,
      );
  const evidence = rt.completeEvidence(command),
    effects = tx.chatFailureEvidence?.(turn.taskRunId);
  if (
    !evidence ||
    !effects ||
    effects.taskVersion !== evidence.run.version ||
    effects.relatedPendingEffects !== 0 ||
    !turn.activation ||
    canonicalJson(turn.activation) !== canonicalJson(evidence.run.modelExecution?.activation)
  )
    return null;
  const ordinal = evidence.run.modelExecution?.lastRequest.ordinal;
  if (
    p &&
    (!ordinal ||
      !p.callId.startsWith(`${p.attemptId}_r${ordinal}_`) ||
      p.callId.length <= `${p.attemptId}_r${ordinal}_`.length)
  )
    return null;
  return { turn, input, task, root, command, evidence };
}
/** Repair never creates a provider request or rebases a saved Complete onto a newer head. */
export async function repairRoomHandoff(
  d: RoomSlicePublicationDeps,
  turnId: string,
): Promise<ChatTurn | null> {
  const work = d.store.atomic((tx) => {
    const f = inspect(tx, turnId, d.sha256);
    if (!f) return null;
    if (roomCompleteEvidence(f.evidence, f.command)) return { turn: publish(tx, f, d) };
    if (
      f.evidence.receipt !== null ||
      f.evidence.run.status !== 'running' ||
      f.evidence.run.version !== f.command.expectedVersion ||
      !roomSliceAuthority(tx, f.root, f.task, d.clock.now().getTime(), d.sha256) ||
      d.clock.now().getTime() >= Date.parse(f.turn.activation!.deadlineAt)
    )
      return null;
    if (
      f.turn.roomHandoff &&
      (f.task.status !== 'waiting' ||
        f.task.waitingChildId !== f.turn.roomHandoff.childTaskId ||
        f.input.state !== 'claimed')
    )
      return null;
    return { command: f.command };
  });
  if (!work) return null;
  if ('turn' in work) return work.turn;
  try {
    await d.tasks.executeWithDisposition(work.command);
  } catch {
    /* Lost responses require identical locked lookup below. */
  }
  return d.store.atomic((tx) => {
    const f = inspect(tx, turnId, d.sha256);
    return f && roomCompleteEvidence(f.evidence, work.command) ? publish(tx, f, d) : null;
  });
}
function publish(
  tx: ConversationTransaction,
  f: NonNullable<ReturnType<typeof inspect>>,
  d: RoomSlicePublicationDeps,
): ChatTurn | null {
  const { turn, input, task, root } = f,
    rt = tx.roomTasks!;
  if (turn.status === 'completed') {
    if (input.state !== 'consumed') return null;
    if (turn.roomSliceDisposition === 'yielded') return turn;
    let final;
    let after = 0;
    for (;;) {
      const page = tx.history(turn.roomId, after, 200);
      final = page.find((m) => m.id === 'reply_' + turn.id);
      if (final || page.length < 200) break;
      after = page.at(-1)!.seq;
    }
    if (!publishedRoomResult(tx, task, d)) return null;
    return final &&
      final.body === turn.text &&
      final.turnId === turn.id &&
      final.authorBotId === turn.bot.id
      ? turn
      : null;
  }
  if (
    !roomSliceAuthority(tx, root, task, d.clock.now().getTime(), d.sha256) ||
    input.state !== 'claimed'
  )
    return null;
  if (turn.roomHandoff) {
    if (task.status !== 'waiting' || task.waitingChildId !== turn.roomHandoff.childTaskId)
      return null;
    const completed = {
      ...turn,
      status: 'completed' as const,
      roomSliceDisposition: 'yielded' as const,
      text: '',
      preparedVersion: null,
    };
    rt.consume(input.id);
    rt.advanceTask(
      { ...task, lastDeliverySeq: Math.max(task.lastDeliverySeq, input.seq) },
      task.revision,
    );
    tx.putChatTurn(completed);
    return completed;
  }
  if (task.status !== 'ready' || turn.status !== 'prepared') return null;
  const draining = rt.inputs(task.id).every((v) => v.id === input.id || v.state === 'consumed');
  if (draining && !roomAssignmentReturnReady(tx, root, task, input.id)) return null;
  if (!d.sha256 && rt.inputs(task.id).some((v) => v.kind === 'delegate')) return null;
  const final = chatFinalMessage(turn, tx.nextSequence(turn.roomId), d.clock.now().toISOString());
  const completed = { ...turn, status: 'completed' as const };
  tx.putMessage(final);
  tx.putChatTurn(completed);
  rt.consume(input.id);
  const remains = rt.inputs(task.id).some((v) => v.state !== 'consumed');
  rt.advanceTask(
    {
      ...task,
      status: remains ? 'ready' : 'completed',
      lastDeliverySeq: Math.max(task.lastDeliverySeq, input.seq),
    },
    task.revision,
  );
  if (!remains) returnResult(tx, root, task, completed, final, f.command.payload.attemptId, d);
  const all = rt.tasks(root.id);
  if (
    tx
      .chatTurns()
      .filter((t) => t.roomDelivery && rt.task(t.roomDelivery.taskId)?.rootId === root.id)
      .every((t) => tx.chatFailureEvidence?.(t.taskRunId)?.relatedPendingEffects === 0) &&
    all.filter((v) => v.kind === 'bot').every((v) => v.status === 'completed') &&
    all
      .filter((v) => v.kind === 'bot')
      .every((v) => rt.inputs(v.id).every((i) => i.state === 'consumed'))
  )
    rt.advanceTask({ ...root, status: 'completed' }, root.revision);
  return completed;
}
