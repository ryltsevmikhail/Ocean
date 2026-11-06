import {
  canonicalJson,
  conversationFailure,
  decideRoomAddress,
  ok,
  roomAgentBinding,
  roomAgentRequestKey,
  validConversationText,
  validRoomAgentRequest,
  type ConversationResult,
  type RoomDeliveryOrigin,
} from '@runnets/domain';
import type {
  RoomTaskActor,
  RoomTaskReceipt,
  RoomTaskOriginFacts,
  RoomTaskBot,
  RoomDeliveryRecord,
} from './room-task-records.js';
import type { RoomTaskPersistenceDeps } from './room-task-persistence.js';
import { roomTaskReceipt } from './room-task-receipt.js';
import { roomTaskIdentity } from './room-task-identity.js';
import { admitRoomModelTransfer } from './room-model-policy.js';
function origin(f: RoomTaskOriginFacts, actor: RoomTaskActor): RoomDeliveryOrigin {
  const { task, root, input, turn } = f;
  return {
    task: {
      ...task,
      members: root.rootPayload.members.map((m) => m.botId),
      grantReferences: root.rootPayload.members.find((m) => m.botId === task.assigneeBotId)!
        .grantReferences,
    },
    botId: turn.bot.id,
    turnId: turn.id,
    deliveryId: input.id,
    attemptId: actor.attemptId,
    callId: actor.callId,
  };
}
export function persistRoomTaskSend(
  d: RoomTaskPersistenceDeps,
  actor: RoomTaskActor,
  request: unknown,
): ConversationResult<RoomTaskReceipt> {
  if (
    !actor ||
    typeof actor !== 'object' ||
    Reflect.ownKeys(actor).length !== 4 ||
    !['turnId', 'taskRunId', 'attemptId'].every((k) =>
      validConversationText(actor[k as keyof RoomTaskActor], 128),
    ) ||
    !validConversationText(actor.callId, 512) ||
    !validRoomAgentRequest(request)
  )
    return conversationFailure('invalid_input');
  const logicalKey = roomAgentRequestKey(actor.turnId, actor.attemptId, actor.callId),
    digest = d.sha256(logicalKey);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw Error('invalid SHA-256 dependency');
  const key = 'room-agent/v1:' + digest;
  try {
    return d.store.atomic((tx) => {
      const prior = tx.receipt(key),
        rt = tx.roomTasks;
      if (!rt) return conversationFailure(prior ? 'request_conflict' : 'admission_closed');
      if (prior) {
        const facts = rt.origin(actor.turnId, actor.taskRunId, actor.attemptId, false);
        if (!facts || facts.root.rootPayload.ownerId !== d.ownerId)
          return conversationFailure('request_conflict');
        const receipt = roomTaskReceipt(
          tx,
          key,
          prior,
          roomAgentBinding(origin(facts, actor), request),
          {
            workspaceId: facts.task.workspaceId,
            roomId: facts.task.roomId,
            author: 'bot',
            body: request.text,
            targetBotId: request.toBotId,
            authorBotId: facts.turn.bot.id,
            turnId: actor.turnId,
          },
        );
        if (!receipt) return conversationFailure('request_conflict');
        const rows = rt.deliveriesForReceipt(key, receipt.messageId);
        return rows.length === 1 &&
          rows[0]!.kind === request.kind &&
          rows[0]!.sourceAttemptId === actor.attemptId &&
          rows[0]!.sourceTurnId === actor.turnId &&
          rows[0]!.fromTaskId === facts.task.id &&
          rows[0]!.causeId === facts.input.id &&
          rows[0]!.senderBotId === facts.turn.bot.id &&
          rows[0]!.recipientBotId === request.toBotId &&
          receipt.rootId === facts.root.id
          ? ok(receipt)
          : conversationFailure('request_conflict');
      }
      if (rt.restored()) return conversationFailure('recovery_required');
      const facts = rt.origin(actor.turnId, actor.taskRunId, actor.attemptId, true);
      if (!facts || facts.root.rootPayload.ownerId !== d.ownerId)
        return conversationFailure('approval_required');
      const { task, root, input, turn, liveRun } = facts;
      const ordinal = liveRun!.modelExecution!.lastRequest.ordinal,
        prefix = `${actor.attemptId}_r${ordinal}_`;
      if (!actor.callId.startsWith(prefix) || actor.callId.length <= prefix.length)
        return conversationFailure('approval_required');
      if (tx.roomPolicy(task.roomId)?.mode === 'text_only')
        return conversationFailure('recovery_required');
      const room = tx.room(task.roomId);
      if (!room) return conversationFailure('unknown_room');
      const members = room.kind === 'direct' ? [room.botId] : room.botIds;
      const decided = decideRoomAddress(origin(facts, actor), request, members);
      if (!decided.ok) return conversationFailure('not_member');
      const recipient = tx.bot(request.toBotId),
        pin = root.rootPayload.members.find((m) => m.botId === request.toBotId);
      const identity = recipient && roomTaskIdentity(tx, recipient);
      if (!pin || !identity || canonicalJson(identity) !== canonicalJson(pin.identity))
        return conversationFailure('provider_unavailable');
      const transfer = admitRoomModelTransfer(tx, room.id, identity);
      if (!transfer.ok) return transfer;
      const message = {
        id: d.nextId(),
        workspaceId: task.workspaceId,
        roomId: task.roomId,
        seq: tx.nextSequence(task.roomId),
        author: 'bot' as const,
        authorBotId: turn.bot.id,
        targetBotId: request.toBotId,
        turnId: turn.id,
        body: request.text,
        createdAt: d.clock.now().toISOString(),
      };
      const child: RoomTaskBot = {
        version: 1,
        revision: 1,
        id: d.nextId(),
        workspaceId: task.workspaceId,
        roomId: task.roomId,
        rootId: root.id,
        parentId: task.id,
        assigneeBotId: request.toBotId,
        kind: 'bot',
        status: 'ready',
        lastDeliverySeq: 0,
        waitingChildId: null,
        rootPayload: null,
      };
      const delivery: RoomDeliveryRecord = {
        version: 1,
        id: d.nextId(),
        workspaceId: task.workspaceId,
        roomId: task.roomId,
        rootId: root.id,
        toTaskId: child.id,
        recipientBotId: request.toBotId,
        causeId: input.id,
        requestKey: key,
        messageId: message.id,
        fromTaskId: task.id,
        sourceTurnId: turn.id,
        senderBotId: turn.bot.id,
        kind: request.kind,
        seq: message.seq,
        position: 0,
        sourceAttemptId: actor.attemptId,
        state: 'queued',
      };
      rt.putTask(child);
      rt.putDelivery(delivery);
      if (request.kind === 'delegate') rt.waitFor(task.id, child.id, task.revision);
      tx.putMessage(message);
      tx.putReceipt(key, {
        binding: decided.value.binding,
        reply: { kind: 'message', data: message },
      });
      return ok({
        version: 1,
        workspaceId: task.workspaceId,
        roomId: task.roomId,
        rootId: root.id,
        messageId: message.id,
        seq: message.seq,
        deliveries: [{ botId: request.toBotId, taskId: child.id, deliveryId: delivery.id }],
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'revision_conflict')
      return conversationFailure('room_busy');
    throw error;
  }
}
