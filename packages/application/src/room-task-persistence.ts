import { persistRoomTaskSend } from './room-task-send.js';
import type { Clock } from './ports.js';
import {
  canonicalJson,
  conversationFailure,
  ok,
  type ConversationMessage,
  type ConversationResult,
} from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type {
  RoomTaskActor,
  RoomTaskReceipt,
  RoomTaskStart,
  RoomTaskBot,
  RoomTaskRoot,
  RoomDeliveryRecord,
} from './room-task-records.js';
import { prepareRoomTaskStart, validRoomTaskStart } from './room-task-start.js';
import { roomTaskReceipt } from './room-task-receipt.js';
export interface RoomTaskPersistenceDeps {
  readonly store: ConversationStore;
  readonly ownerId: string;
  readonly clock: Clock;
  readonly nextId: () => string;
  readonly sha256: (text: string) => string;
}
/** Inert admissions only; no model/provider/service dispatch capability. */
export class RoomTaskPersistence {
  readonly deps: RoomTaskPersistenceDeps;
  constructor(deps: RoomTaskPersistenceDeps) {
    this.deps = deps;
  }
  start(input: RoomTaskStart): ConversationResult<RoomTaskReceipt> {
    if (!validRoomTaskStart(input)) return conversationFailure('invalid_input');
    const d = this.deps,
      binding = canonicalJson([
        'RoomTaskStart/v1',
        d.ownerId,
        input.workspaceId,
        input.roomId,
        input.text,
        input.initialBotIds,
        input.participants,
        input.mandate,
      ]);
    if (new TextEncoder().encode(binding).length > 262144)
      return conversationFailure('invalid_input');
    return d.store.atomic((tx) => {
      const prior = tx.receipt(input.requestId);
      if (prior) {
        const room = tx.room(input.roomId);
        if (!room || room.workspaceId !== input.workspaceId)
          return conversationFailure('request_conflict');
        const receipt = roomTaskReceipt(tx, input.requestId, prior, binding, {
          workspaceId: input.workspaceId,
          roomId: input.roomId,
          author: 'user',
          body: input.text,
          targetBotId: room.kind === 'direct' ? room.botId : null,
        });
        if (!receipt) return conversationFailure('request_conflict');
        const rt = tx.roomTasks!,
          root = rt.task(receipt.rootId);
        const rows = rt.deliveriesForReceipt(input.requestId, receipt.messageId);
        return root?.kind === 'root' &&
          root.rootPayload.ownerId === d.ownerId &&
          rows.every((r) => r.kind === 'start') &&
          canonicalJson(receipt.deliveries.map((r) => r.botId)) ===
            canonicalJson(input.initialBotIds) &&
          canonicalJson(root.rootPayload.mandate) === canonicalJson(input.mandate) &&
          canonicalJson(
            root.rootPayload.members.map((m) => ({
              botId: m.botId,
              grantReferences: m.grantReferences,
            })),
          ) === canonicalJson(input.participants)
          ? ok(receipt)
          : conversationFailure('request_conflict');
      }
      const prepared = prepareRoomTaskStart(tx, input, d);
      if (!prepared.ok) return prepared;
      const { room, members } = prepared.value,
        rt = tx.roomTasks!;
      const root: RoomTaskRoot = {
        version: 1,
        revision: 1,
        id: d.nextId(),
        workspaceId: input.workspaceId,
        roomId: room.id,
        rootId: '',
        status: 'ready',
        kind: 'root',
        parentId: null,
        assigneeBotId: null,
        lastDeliverySeq: 0,
        waitingChildId: null,
        rootPayload: {
          ownerId: d.ownerId,
          mandate: structuredClone(input.mandate),
          members,
          limits: { concurrentSlices: 2, totalSlices: 32, providerStarts: 64, toolCalls: 64 },
        },
      };
      const rooted: RoomTaskRoot = { ...root, rootId: root.id };
      const message: ConversationMessage = {
        id: d.nextId(),
        workspaceId: input.workspaceId,
        roomId: room.id,
        seq: tx.nextSequence(room.id),
        author: 'user',
        targetBotId: room.kind === 'direct' ? room.botId : null,
        body: input.text,
        createdAt: d.clock.now().toISOString(),
      };
      const children = input.initialBotIds.map((botId, position) => {
        const task: RoomTaskBot = {
          version: 1,
          revision: 1,
          id: d.nextId(),
          workspaceId: input.workspaceId,
          roomId: room.id,
          rootId: root.id,
          status: 'ready',
          kind: 'bot',
          parentId: root.id,
          assigneeBotId: botId,
          lastDeliverySeq: 0,
          waitingChildId: null,
          rootPayload: null,
        };
        const delivery: RoomDeliveryRecord = {
          version: 1,
          id: d.nextId(),
          workspaceId: input.workspaceId,
          roomId: room.id,
          rootId: root.id,
          toTaskId: task.id,
          recipientBotId: botId,
          causeId: root.id,
          requestKey: input.requestId,
          messageId: message.id,
          fromTaskId: null,
          sourceTurnId: null,
          senderBotId: null,
          kind: 'start',
          seq: message.seq,
          position,
          sourceAttemptId: null,
          state: 'queued',
        };
        return { task, delivery };
      });
      // From the first write onwards, failures throw through the adapter's rollback boundary.
      rt.putTask(rooted);
      for (const { task, delivery } of children) {
        rt.putTask(task);
        rt.putDelivery(delivery);
      }
      tx.putMessage(message);
      tx.putReceipt(input.requestId, { binding, reply: { kind: 'message', data: message } });
      return ok({
        version: 1,
        workspaceId: input.workspaceId,
        roomId: room.id,
        rootId: root.id,
        messageId: message.id,
        seq: message.seq,
        deliveries: children.map(({ task, delivery }) => ({
          botId: task.assigneeBotId,
          taskId: task.id,
          deliveryId: delivery.id,
        })),
      });
    });
  }
  send(actor: RoomTaskActor, request: unknown): ConversationResult<RoomTaskReceipt> {
    return persistRoomTaskSend(this.deps, actor, request);
  }
}
