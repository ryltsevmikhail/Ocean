import { canonicalJson, type ChatTurn, type ConversationMessage } from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import type { RoomTaskBot, RoomTaskRoot, RoomDeliveryRecord } from './room-task-records.js';
import type { RoomSlicePublicationDeps } from './room-slice-publication.js';
import { inputEvidence, resultBinding } from './room-delivery-evidence.js';
export function returnResult(
  tx: ConversationTransaction,
  root: RoomTaskRoot,
  task: RoomTaskBot,
  turn: ChatTurn,
  final: ConversationMessage,
  attemptId: string,
  d: RoomSlicePublicationDeps,
): void {
  const rt = tx.roomTasks!,
    edge = rt.inputs(task.id).find((v) => v.kind === 'delegate' && v.toTaskId === task.id);
  if (!edge) return;
  const parent = rt.task(task.parentId);
  if (
    !parent ||
    parent.kind !== 'bot' ||
    edge.fromTaskId !== parent.id ||
    parent.status !== 'waiting' ||
    parent.waitingChildId !== task.id
  )
    throw Error('invalid result wait');
  const digest = d.sha256?.(edge.id);
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw Error('result digest unavailable');
  const key = `room-result/v1:${digest}`;
  const result: RoomDeliveryRecord = {
    version: 1,
    id: `result_${digest}`,
    workspaceId: root.workspaceId,
    roomId: root.roomId,
    rootId: root.id,
    toTaskId: parent.id,
    recipientBotId: parent.assigneeBotId,
    causeId: edge.id,
    requestKey: key,
    messageId: final.id,
    fromTaskId: task.id,
    sourceTurnId: turn.id,
    senderBotId: task.assigneeBotId,
    kind: 'result',
    seq: final.seq,
    position: 0,
    sourceAttemptId: attemptId,
    state: 'queued',
  };
  const binding = resultBinding(edge, result, turn, final),
    prior = tx.receipt(key);
  if (prior) {
    const rows = rt.deliveriesForReceipt(key, final.id);
    if (
      prior.binding !== binding ||
      canonicalJson(prior.reply) !== canonicalJson({ kind: 'message', data: final }) ||
      rows.length !== 1 ||
      canonicalJson(rows[0]) !== canonicalJson(result)
    )
      throw Error('result receipt conflict');
  } else {
    rt.putDelivery(result);
    tx.putReceipt(key, { binding, reply: { kind: 'message', data: final } });
  }
  rt.advanceTask({ ...parent, status: 'ready', waitingChildId: null }, parent.revision);
}

/** A lost response may replay after the parent advanced; verify immutable result facts only. */
export function publishedRoomResult(
  tx: ConversationTransaction,
  task: RoomTaskBot,
  d: RoomSlicePublicationDeps,
): boolean {
  const rt = tx.roomTasks!,
    edge = rt.inputs(task.id).find((v) => v.kind === 'delegate');
  if (!edge) return true;
  if (task.status !== 'completed') return true;
  const digest = d.sha256?.(edge.id);
  if (!digest) return false;
  const key = `room-result/v1:${digest}`,
    receipt = tx.receipt(key),
    rows = rt.deliveriesForReceipt(key, '');
  const row = rows[0],
    final = row && tx.history(task.roomId, row.seq - 1, 1)[0];
  const turn = row?.sourceTurnId && tx.chatTurn(row.sourceTurnId);
  if (
    !receipt ||
    !row ||
    rows.length !== 1 ||
    !final ||
    !turn ||
    turn.status !== 'completed' ||
    turn.roomSliceDisposition !== undefined ||
    row.kind !== 'result' ||
    row.causeId !== edge.id ||
    row.fromTaskId !== task.id ||
    row.toTaskId !== edge.fromTaskId ||
    row.rootId !== edge.rootId ||
    row.senderBotId !== task.assigneeBotId ||
    final.id !== row.messageId ||
    final.id !== 'reply_' + turn.id ||
    final.turnId !== turn.id ||
    final.authorBotId !== task.assigneeBotId ||
    final.targetBotId !== task.assigneeBotId ||
    final.body !== turn.text ||
    receipt.binding !== resultBinding(edge, row, turn, final) ||
    canonicalJson(receipt.reply) !== canonicalJson({ kind: 'message', data: final })
  )
    return false;
  const root = rt.task(edge.rootId),
    parent = edge.fromTaskId && rt.task(edge.fromTaskId);
  return (
    !!root &&
    root.kind === 'root' &&
    !!parent &&
    parent.kind === 'bot' &&
    !!inputEvidence(tx, row, parent, root, true)
  );
}
