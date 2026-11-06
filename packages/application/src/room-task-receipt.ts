import { canonicalJson, validConversationText, type ConversationMessage } from '@runnets/domain';
import type { ConversationReceipt, ConversationTransaction } from './conversation-ports.js';
import type { RoomDeliveryRecord, RoomTaskReceipt } from './room-task-records.js';
type MessageIntent = Pick<
  ConversationMessage,
  'workspaceId' | 'roomId' | 'author' | 'body' | 'targetBotId' | 'authorBotId' | 'turnId'
>;
/** Replays immutable joins only; current eligibility never reauthorizes old receipts. */
export function roomTaskReceipt(
  tx: ConversationTransaction,
  key: string,
  receipt: ConversationReceipt,
  binding: string,
  expected: MessageIntent,
): RoomTaskReceipt | null {
  if (receipt.binding !== binding || receipt.reply.kind !== 'message' || !tx.roomTasks) return null;
  const m = receipt.reply.data;
  if (
    !m ||
    typeof m !== 'object' ||
    !validConversationText(m.id, 128) ||
    !Number.isSafeInteger(m.seq) ||
    m.seq < 1 ||
    m.workspaceId !== expected.workspaceId ||
    m.roomId !== expected.roomId ||
    m.author !== expected.author ||
    m.body !== expected.body ||
    m.targetBotId !== expected.targetBotId ||
    m.authorBotId !== expected.authorBotId ||
    m.turnId !== expected.turnId
  )
    return null;
  const stored = tx.history(m.roomId, m.seq - 1, 1)[0];
  if (!stored || canonicalJson(stored) !== canonicalJson(m)) return null;
  const ds = tx.roomTasks.deliveriesForReceipt(key, m.id);
  if (ds.length < 1 || ds.length > 32) return null;
  const first = ds[0]!,
    root = tx.roomTasks.task(first.rootId);
  if (
    !root ||
    root.kind !== 'root' ||
    root.workspaceId !== m.workspaceId ||
    root.roomId !== m.roomId
  )
    return null;
  if (
    !ds.every(
      (d, i) =>
        d.position === i &&
        d.requestKey === key &&
        d.workspaceId === m.workspaceId &&
        d.roomId === m.roomId &&
        d.messageId === m.id &&
        d.seq === m.seq &&
        d.rootId === root.id &&
        validTarget(tx, d, first, m),
    )
  )
    return null;
  return {
    version: 1,
    workspaceId: m.workspaceId,
    roomId: m.roomId,
    rootId: root.id,
    messageId: m.id,
    seq: m.seq,
    deliveries: ds.map((d) => ({ botId: d.recipientBotId, taskId: d.toTaskId, deliveryId: d.id })),
  };
}
function validTarget(
  tx: ConversationTransaction,
  d: RoomDeliveryRecord,
  first: RoomDeliveryRecord,
  m: ConversationMessage,
): boolean {
  const t = tx.roomTasks!.task(d.toTaskId);
  if (
    !t ||
    t.kind !== 'bot' ||
    t.rootId !== d.rootId ||
    t.roomId !== d.roomId ||
    t.workspaceId !== d.workspaceId ||
    t.assigneeBotId !== d.recipientBotId ||
    d.kind !== first.kind
  )
    return false;
  if (d.kind === 'start')
    return (
      m.author === 'user' &&
      t.parentId === d.rootId &&
      d.fromTaskId === null &&
      d.sourceAttemptId === null &&
      d.sourceTurnId === null &&
      d.senderBotId === null
    );
  return (
    (d.kind === 'message' || d.kind === 'delegate') &&
    d.position === 0 &&
    m.author === 'bot' &&
    d.senderBotId === m.authorBotId &&
    d.recipientBotId === m.targetBotId &&
    d.sourceTurnId === m.turnId &&
    t.parentId === d.fromTaskId &&
    d.sourceAttemptId !== null
  );
}
