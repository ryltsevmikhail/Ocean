import type { ConversationTransaction } from './conversation-ports.js';
import { freezeRoomTask } from './room-task-host.js';
import { roomTools } from './room-task-tools.js';
import { admitRoomCount, roomCodingTask } from './room-task-authority.js';
import { admitImageRequest, type ImageAssetResolverPort } from './image-content.js';
import { createChatCommand } from './commands.js';
import { roomSliceAuthority, inputEvidence } from './room-delivery-evidence.js';
import { canonicalJson, taskRunId, type ChatTurn, type TaskRunId } from '@runnets/domain';
import type { RoomTaskPersistenceDeps } from './room-task-persistence.js';
import type { ProviderActivationPort } from './model-activation-types.js';
import type { ChatMessage, ProviderPort } from './provider.js';
import type { GrantedPluginTools } from './plugin-turn-tools.js';
import { freezeModelActivation } from './model-activation-snapshot.js';
import { providerAdmits } from './provider-admission.js';
import { roomContext } from './room-context.js';
export type RoomDeliveryClaimDeps = RoomTaskPersistenceDeps & {
  readonly resolver: ProviderActivationPort;
  readonly codingAvailable?: boolean;
  readonly images?: ImageAssetResolverPort;
};
export type RoomDeliveryClaim =
  | Readonly<{ kind: 'held' }>
  | Readonly<{ kind: 'existing'; turn: ChatTurn }>
  | Readonly<{
      kind: 'claimed';
      turn: ChatTurn;
      provider: ProviderPort;
      messages: readonly ChatMessage[];
      parentRunId: TaskRunId | null;
      tools: GrantedPluginTools | null;
    }>;
/** Claim at most one exact committed delivery under the adapter's immediate lock. */
export function claimRoomDelivery(d: RoomDeliveryClaimDeps, deliveryId: string): RoomDeliveryClaim {
  return d.store.atomic((tx): RoomDeliveryClaim => {
    const rt = tx.roomTasks,
      delivery = rt?.delivery(deliveryId);
    if (!rt || !delivery) return { kind: 'held' };
    const task = rt.task(delivery.toTaskId),
      root = rt.task(delivery.rootId);
    if (
      !task ||
      task.kind !== 'bot' ||
      !root ||
      root.kind !== 'root' ||
      root.rootPayload.ownerId !== d.ownerId ||
      tx.workspace()?.id !== root.workspaceId ||
      task.rootId !== root.id ||
      task.assigneeBotId !== delivery.recipientBotId ||
      ![task, root].every(
        (v) => v.workspaceId === delivery.workspaceId && v.roomId === delivery.roomId,
      )
    )
      return { kind: 'held' };
    const existing = tx.chatTurns().find((t) => t.roomDelivery?.deliveryId === delivery.id);
    if (existing)
      return existing.roomDelivery?.taskId === task.id &&
        existing.workspaceId === root.workspaceId &&
        existing.roomId === root.roomId &&
        existing.bot.id === task.assigneeBotId &&
        existing.inboundMessageId === delivery.messageId &&
        existing.readThroughSeq === delivery.seq
        ? { kind: 'existing', turn: existing }
        : { kind: 'held' };
    if (
      delivery.state !== 'queued' ||
      task.status !== 'ready' ||
      root.rootPayload.ownerId !== d.ownerId ||
      !roomSliceAuthority(tx, root, task, d.clock.now().getTime(), d.sha256)
    )
      return { kind: 'held' };
    const marked = tx
      .chatTurns()
      .filter((t) => t.roomDelivery && rt.task(t.roomDelivery.taskId)?.rootId === root.id);
    const active = marked.filter((t) =>
      ['accepted', 'dispatching', 'prepared', 'uncertain'].includes(t.status),
    );
    if (active.length >= 2 || active.some((t) => t.roomDelivery!.taskId === task.id))
      return { kind: 'held' };
    const next = rt
      .inputs(task.id)
      .find((v) => v.state === 'queued' && inputEvidence(tx, v, task, root));
    if (next?.id !== delivery.id) return { kind: 'held' };
    if (!admitRoomCount(rt.counts(root.id), 'child_runs')) {
      freezeRoomTask(tx, root, 'slice_limit', d.sha256);
      return { kind: 'held' };
    }
    const facts = inputEvidence(tx, delivery, task, root)!;
    const coding = roomCodingTask(tx, root, d.sha256);
    if (coding?.task.devBotId === task.assigneeBotId && d.codingAvailable !== true)
      return { kind: 'held' };
    const bot = tx.bot(task.assigneeBotId)!,
      binding = tx.modelBinding(bot.id)!;
    const at = d.clock.now().toISOString(),
      activation = d.resolver.resolve({ bot, binding }, at);
    if (!activation.ok) return { kind: 'held' };
    const snapshot = freezeModelActivation(activation.value.snapshot);
    if (
      canonicalJson(snapshot.identity) !==
        canonicalJson(root.rootPayload.members.find((m) => m.botId === bot.id)!.identity) ||
      snapshot.admittedAt !== at ||
      Date.parse(snapshot.deadlineAt) <= Date.parse(at) ||
      !providerAdmits(activation.value.provider, bot, snapshot)
    )
      return { kind: 'held' };
    const room = tx.room(task.roomId)!;
    const messages = roomContext(
      tx,
      room,
      bot,
      { text: facts.message.body, messageId: facts.message.id, phase: 'persisted' },
      d.images,
      delivery.seq,
      facts.message.author === 'bot' ? facts.message : undefined,
    );
    if (
      messages.ok &&
      !admitImageRequest({
        provider: activation.value.provider,
        model: bot.model,
        messages: messages.value,
        capabilities: snapshot.capabilities,
      }).ok
    )
      return { kind: 'held' };
    if (!messages.ok) return { kind: 'held' };
    const id = d.nextId();
    const turn: ChatTurn = {
      id,
      workspaceId: root.workspaceId,
      roomId: root.roomId,
      requestId: `room-slice/v1:${id}`,
      taskRunId: 'tr_' + id,
      inboundMessageId: delivery.messageId,
      readThroughSeq: delivery.seq,
      bot,
      modelBinding: binding,
      activation: snapshot,
      roomDelivery: { version: 1, taskId: task.id, deliveryId: delivery.id },
      ...(coding?.task.devBotId === bot.id ? { codingTaskId: coding.task.id } : {}),
      status: 'accepted',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    };
    const effects = tx.chatFailureEvidence?.(turn.taskRunId);
    if (!effects || effects.taskVersion !== 0 || effects.relatedPendingEffects !== 0)
      return { kind: 'held' };
    rt.claim(delivery.id); // All failures after this first write must throw for rollback.
    tx.putChatTurn(turn);
    return {
      kind: 'claimed',
      turn,
      provider: activation.value.provider,
      messages: messages.value,
      parentRunId: facts.parent,
      tools: snapshot.capabilities.tools ? roomTools(d, turn.id) : null,
    };
  });
}
/** Discovery only: no fresh IDs, new activation deadline or model dispatch on restart. */
export function recoverUnstartedRoomClaims(
  d: RoomDeliveryClaimDeps,
): readonly Extract<RoomDeliveryClaim, { kind: 'claimed' }>[] {
  return d.store.atomic((tx) => {
    const rt = tx.roomTasks;
    if (!rt) return [];
    return tx.chatTurns().flatMap((turn) => {
      const proof = inspectUnstartedRoomClaim(tx, turn, d);
      if (!proof) return [];
      const { input, facts } = proof;
      const resolved = d.resolver.resolve(
        { bot: turn.bot, binding: turn.modelBinding! },
        turn.activation!.admittedAt,
      );
      if (
        !resolved.ok ||
        canonicalJson(freezeModelActivation(resolved.value.snapshot)) !==
          canonicalJson(turn.activation) ||
        !providerAdmits(resolved.value.provider, turn.bot, turn.activation)
      )
        return [];
      const messages = roomContext(
        tx,
        tx.room(turn.roomId)!,
        turn.bot,
        { text: facts.message.body, messageId: facts.message.id, phase: 'persisted' },
        d.images,
        input.seq,
        facts.message.author === 'bot' ? facts.message : undefined,
      );
      return messages.ok
        ? [
            {
              kind: 'claimed' as const,
              turn,
              provider: resolved.value.provider,
              messages: messages.value,
              parentRunId: facts.parent,
              tools: turn.activation!.capabilities.tools ? roomTools(d, turn.id) : null,
            },
          ]
        : [];
    });
  });
}

export function inspectUnstartedRoomClaim(
  tx: ConversationTransaction,
  turn: ChatTurn,
  d: RoomTaskPersistenceDeps,
  publication = false,
) {
  const rt = tx.roomTasks;
  if (!rt) return null;
  if (
    turn.status !== 'accepted' ||
    !turn.roomDelivery ||
    !turn.activation ||
    !turn.modelBinding ||
    turn.roomHandoff ||
    turn.continuationReviewId !== undefined ||
    (!publication && d.clock.now().getTime() >= Date.parse(turn.activation.deadlineAt))
  )
    return null;
  const input = rt.delivery(turn.roomDelivery.deliveryId),
    task = rt.task(turn.roomDelivery.taskId);
  const root = task && rt.task(task.rootId);
  if (
    !input ||
    input.state !== 'claimed' ||
    !task ||
    task.kind !== 'bot' ||
    task.status !== 'ready' ||
    !root ||
    root.kind !== 'root' ||
    root.rootPayload.ownerId !== d.ownerId ||
    !roomSliceAuthority(tx, root, task, d.clock.now().getTime(), d.sha256, publication)
  )
    return null;
  const siblings = tx
    .chatTurns()
    .filter(
      (t) =>
        t.roomDelivery?.taskId === task.id &&
        ['accepted', 'dispatching', 'prepared', 'uncertain'].includes(t.status),
    );
  if (siblings.length !== 1 || siblings[0]?.id !== turn.id) return null;
  const facts = inputEvidence(tx, input, task, root, false, publication);
  if (!facts) return null;
  const evidence = rt.unstartedEvidence(createChatCommand(turn, facts.parent)),
    effects = tx.chatFailureEvidence?.(turn.taskRunId);
  if (
    !evidence ||
    !effects ||
    effects.relatedPendingEffects !== 0 ||
    effects.taskVersion !== (evidence.kind === 'absent' ? 0 : 1)
  )
    return null;
  return { input, task, root, facts, evidence };
}
export function unstartedRoomClaimRuns(d: RoomTaskPersistenceDeps): readonly TaskRunId[] {
  return d.store.atomic((tx) =>
    tx
      .chatTurns()
      .filter((turn) => inspectUnstartedRoomClaim(tx, turn, d) !== null)
      .map((turn) => taskRunId(turn.taskRunId)),
  );
}
