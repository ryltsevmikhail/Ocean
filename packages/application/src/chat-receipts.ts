import { taskRunId, type ChatTurn, type ConversationMessage } from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type { TaskRunService } from './service.js';

export interface ChatRoomScope {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface ReceiptQuery extends ChatRoomScope {
  readonly requestId: string;
}
export interface RunQuery extends ChatRoomScope {
  readonly runId: string;
}
export interface ChatAdmissionReceipt extends ReceiptQuery {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly runId: string | null;
}
function turnReceipt(turn: ChatTurn) {
  return {
    requestId: turn.requestId,
    workspaceId: turn.workspaceId,
    roomId: turn.roomId,
    messageId: turn.inboundMessageId,
    turnId: turn.id,
    runId: turn.taskRunId,
  };
}
export function chatReceipt(
  requestId: string,
  data: ChatTurn | ConversationMessage,
): ChatAdmissionReceipt {
  if ('taskRunId' in data) return turnReceipt(data);
  return {
    requestId,
    workspaceId: data.workspaceId,
    roomId: data.roomId,
    messageId: data.id,
    turnId: null,
    runId: null,
  };
}
export function readChatReceipt(store: ConversationStore, query: ReceiptQuery) {
  return store.atomic((tx) => {
    if (tx.workspace()?.id !== query.workspaceId) return null;
    const receipt = tx.receipt(query.requestId);
    if (!receipt) return null;
    const reply = receipt.reply;
    // Message receipts also exist for the independent RecordUserMessage command.
    if (
      reply.kind !== 'turn' &&
      !(reply.kind === 'message' && receipt.binding.startsWith('["SendDirect",'))
    )
      return null;
    if (reply.data.workspaceId !== query.workspaceId || reply.data.roomId !== query.roomId)
      return null;
    return chatReceipt(query.requestId, reply.data);
  });
}
export async function readChatRun(
  store: ConversationStore,
  tasks: TaskRunService,
  query: RunQuery,
) {
  const { workspaceId, roomId, runId } = query;
  const turn = store.atomic((tx) => {
    if (tx.workspace()?.id !== workspaceId) return null;
    const found = tx.roomChatRun(workspaceId, roomId, runId);
    return found?.workspaceId === workspaceId &&
      found.roomId === roomId &&
      found.taskRunId === runId
      ? found
      : null;
  });
  if (!turn) return null;
  const disposition: unknown = turn.roomSliceDisposition;
  if (
    disposition !== undefined &&
    (disposition !== 'yielded' ||
      !turn.roomDelivery ||
      !turn.roomHandoff ||
      turn.status !== 'completed' ||
      turn.text !== '' ||
      turn.preparedVersion !== null)
  )
    throw Error('invalid room disposition');
  const state = await tasks.state(taskRunId(runId));
  return {
    ...turnReceipt(turn),
    performerId: turn.bot.id,
    turnStatus: turn.status,
    taskStatus:
      state.status !== 'absent'
        ? state.status
        : turn.status === 'accepted'
          ? ('admitted_before_run' as const)
          : ('not_created' as const),
    version: state.version,
    resultMessageId:
      turn.status === 'completed' && turn.roomSliceDisposition !== 'yielded'
        ? 'reply_' + turn.id
        : null,
  };
}
