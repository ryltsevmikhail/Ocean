import {
  canonicalJson,
  conversationFailure,
  ok,
  ownerGrantApplies,
  validConversationText,
  validOwnerGrantReference,
  validOwnerPermission,
  type ConversationResult,
  type Room,
} from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import type { RoomTaskMemberPin, RoomTaskStart } from './room-task-records.js';
import type { RoomTaskPersistenceDeps } from './room-task-persistence.js';
import { roomTaskIdentity } from './room-task-identity.js';
import { admitRoomModelTransfer } from './room-model-policy.js';
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]) =>
  Reflect.ownKeys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
const list = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean) &&
  Reflect.ownKeys(v).length === v.length + 1;
const id = (v: unknown): v is string => typeof v === 'string' && validConversationText(v, 128);
export function validRoomTaskStart(v: unknown): v is RoomTaskStart {
  if (
    !object(v) ||
    !keys(v, [
      'workspaceId',
      'roomId',
      'requestId',
      'text',
      'initialBotIds',
      'participants',
      'mandate',
    ]) ||
    !['workspaceId', 'roomId', 'requestId'].every((k) => id(v[k])) ||
    typeof v['text'] !== 'string' ||
    !validConversationText(v['text'], 16384) ||
    !list(v['initialBotIds'], 32) ||
    !v['initialBotIds'].length ||
    !v['initialBotIds'].every(id) ||
    new Set(v['initialBotIds']).size !== v['initialBotIds'].length ||
    !list(v['participants'], 32) ||
    !v['participants'].length
  )
    return false;
  const ps = v['participants'];
  if (
    !ps.every(
      (p) =>
        object(p) &&
        keys(p, ['botId', 'grantReferences']) &&
        id(p['botId']) &&
        list(p['grantReferences'], 32) &&
        p['grantReferences'].every(validOwnerGrantReference) &&
        new Set(p['grantReferences'].map((r) => r.grantId)).size === p['grantReferences'].length,
    )
  )
    return false;
  const ids = ps.map((p) => (p as { botId: string }).botId),
    m = v['mandate'];
  return (
    new Set(ids).size === ids.length &&
    v['initialBotIds'].every((b) => ids.includes(b)) &&
    object(m) &&
    keys(m, ['projectId', 'codingTaskId', 'permissions']) &&
    (m['projectId'] === null || id(m['projectId'])) &&
    (m['codingTaskId'] === null || id(m['codingTaskId'])) &&
    list(m['permissions'], 256) &&
    m['permissions'].every(validOwnerPermission) &&
    new TextEncoder().encode(canonicalJson(v)).length <= 262144
  );
}
export function prepareRoomTaskStart(
  tx: ConversationTransaction,
  input: RoomTaskStart,
  d: RoomTaskPersistenceDeps,
): ConversationResult<{ room: Room; members: readonly RoomTaskMemberPin[] }> {
  const rt = tx.roomTasks,
    ws = tx.workspace();
  if (!rt) return conversationFailure('admission_closed');
  if (ws?.id !== input.workspaceId) return conversationFailure('workspace_conflict');
  const room = tx.room(input.roomId);
  if (!room) return conversationFailure('unknown_room');
  if (rt.restored() || tx.roomPolicy(room.id)?.mode === 'text_only')
    return conversationFailure('recovery_required');
  if (tx.broadcastBatchForRoom(room.id)) return conversationFailure('batch_open');
  const active = tx.activeChatTurn(room.id);
  if (active)
    return conversationFailure(active.status === 'uncertain' ? 'recovery_required' : 'room_busy');
  const current = room.kind === 'direct' ? [room.botId] : room.botIds;
  let projectId = d.sha256(ws.root);
  const selected =
    input.mandate.codingTaskId === null ? null : rt.codingTask(input.mandate.codingTaskId);
  if (input.mandate.codingTaskId !== null) {
    if (
      !selected ||
      selected.id !== input.mandate.codingTaskId ||
      selected.workspaceId !== ws.id ||
      selected.ownerRoomId !== room.id
    )
      return conversationFailure('invalid_input');
    projectId = d.sha256(selected.projectRoot);
  }
  if (input.mandate.projectId !== null && input.mandate.projectId !== projectId)
    return conversationFailure('invalid_input');
  const members: RoomTaskMemberPin[] = [];
  for (const p of input.participants) {
    if (!current.includes(p.botId)) return conversationFailure('not_member');
    const bot = tx.bot(p.botId),
      identity = bot && roomTaskIdentity(tx, bot);
    if (!bot || bot.workspaceId !== ws.id || !identity)
      return conversationFailure('provider_unavailable');
    const transfer = admitRoomModelTransfer(tx, room.id, identity);
    if (!transfer.ok) return transfer;
    for (const ref of p.grantReferences) {
      const grant = rt.grant(ref.grantId),
        subject = {
          workspaceId: ws.id,
          roomId: room.id,
          botId: p.botId,
          projectId,
          taskId: input.mandate.codingTaskId,
        };
      if (
        !grant ||
        grant.id !== ref.grantId ||
        grant.revision !== ref.revision ||
        grant.owner.ownerId !== d.ownerId ||
        !ownerGrantApplies(grant, subject, d.clock.now().getTime()) ||
        (grant.subject.taskId !== null &&
          (!selected || selected.status !== 'reserved' || selected.devBotId !== p.botId))
      )
        return conversationFailure('approval_required');
    }
    members.push({ botId: p.botId, grantReferences: structuredClone(p.grantReferences), identity });
  }
  return ok({ room, members });
}
