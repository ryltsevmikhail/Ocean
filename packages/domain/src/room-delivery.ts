import { validConversationText } from './conversations.js';
import { DomainError, err, ok, type Result } from './errors.js';
import { validOwnerGrantReference } from './owner-scope-grant.js';
import { canonicalJson } from './plugin-catalog.js';
import type { RoomTaskAddress } from './room-task.js';
import {
  authorityDenseArray,
  authorityNames,
  authorityObject,
} from './service-authority-validation.js';

/** Delivery addressing only; no receipt format or runtime validator is frozen here. */
export interface RoomDeliveryAddress {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly rootId: string;
  readonly toTaskId: string;
  readonly recipientBotId: string;
  readonly causeId: string;
  readonly requestKey: string;
  readonly messageId: string;
  readonly fromTaskId: string | null;
  readonly sourceTurnId: string | null;
  readonly senderBotId: string | null;
  readonly kind: 'start' | 'message' | 'delegate' | 'result';
  readonly seq: number;
}
export interface RoomAgentRequest {
  readonly kind: 'message' | 'delegate';
  readonly toBotId: string;
  readonly text: string;
}
/** All origin identity comes from the runtime, including its round-qualified callId. */
export interface RoomDeliveryOrigin {
  readonly task: RoomTaskAddress;
  readonly botId: string;
  readonly turnId: string;
  readonly deliveryId: string;
  readonly attemptId: string;
  readonly callId: string;
}
export interface RoomAddressDecision {
  readonly senderBotId: string;
  readonly recipientBotId: string;
  readonly text: string;
  readonly kind: 'message' | 'delegate';
  readonly requestKey: string;
  readonly binding: string;
}
const text = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && validConversationText(value, max);

function validTask(value: unknown): value is RoomTaskAddress {
  if (!authorityObject(value)) return false;
  const refs = value['grantReferences'];
  return (
    ['id', 'workspaceId', 'roomId', 'rootId', 'parentId', 'assigneeBotId'].every((key) =>
      text(value[key]),
    ) &&
    value['id'] !== value['rootId'] &&
    value['parentId'] !== value['id'] &&
    authorityNames(value['members'], 32) &&
    value['members'].includes(value['assigneeBotId'] as string) &&
    Array.isArray(refs) &&
    refs.length <= 32 &&
    authorityDenseArray(refs) &&
    refs.every(validOwnerGrantReference) &&
    new Set(refs.map((ref) => ref.grantId)).size === refs.length &&
    ['ready', 'waiting', 'paused', 'completed', 'stopped'].some(
      (status) => status === value['status'],
    ) &&
    Number.isSafeInteger(value['lastDeliverySeq']) &&
    Number(value['lastDeliverySeq']) >= 0
  );
}
function validRequest(value: unknown): value is RoomAgentRequest {
  return (
    authorityObject(value) &&
    Reflect.ownKeys(value).length === 3 &&
    ['kind', 'toBotId', 'text'].every((key) => Object.hasOwn(value, key)) &&
    (value['kind'] === 'message' || value['kind'] === 'delegate') &&
    text(value['toBotId']) &&
    text(value['text'], 16384)
  );
}

/** Pure routing decision: no allocation, permission grant, persistence or execution. */
export function decideRoomAddress(
  origin: RoomDeliveryOrigin,
  request: unknown,
  currentMemberIds: readonly string[],
): Result<RoomAddressDecision> {
  if (
    !authorityObject(origin) ||
    !validTask(origin.task) ||
    !['botId', 'turnId', 'deliveryId', 'attemptId'].every((key) => text(origin[key])) ||
    !text(origin.callId, 512) ||
    !validRequest(request) ||
    !Array.isArray(currentMemberIds) ||
    currentMemberIds.length > 32 ||
    !authorityDenseArray(currentMemberIds) ||
    !currentMemberIds.every((id) => text(id)) ||
    new Set(currentMemberIds).size !== currentMemberIds.length
  )
    return err(DomainError.invalidArgument('malformed room addressing input'));
  const { task, botId, turnId, attemptId, callId, deliveryId } = origin;
  const { kind, toBotId, text: body } = request;
  if (
    task.status !== 'ready' ||
    botId !== task.assigneeBotId ||
    botId === toBotId ||
    ![botId, toBotId].every((id) => task.members.includes(id) && currentMemberIds.includes(id))
  )
    return err(DomainError.invariant('room task is not eligible for this route'));
  return ok({
    senderBotId: botId,
    recipientBotId: toBotId,
    text: body,
    kind,
    requestKey: canonicalJson(['room-agent/v1', turnId, attemptId, callId]),
    binding: canonicalJson([
      task.workspaceId,
      task.roomId,
      task.rootId,
      task.id,
      deliveryId,
      botId,
      kind,
      toBotId,
      body,
    ]),
  });
}
