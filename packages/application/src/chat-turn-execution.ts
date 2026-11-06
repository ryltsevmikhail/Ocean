import { releaseUnstartedRoomClaim, recordCancelledRoomTurn } from './room-task-cancellation.js';
import { createChatCommand } from './commands.js';
import { combineChatTools } from './chat-turn-tools.js';
import { repairRoomHandoff } from './room-slice-publication.js';
import { roomSliceAuthority } from './room-delivery-evidence.js';
import { canonicalJson, type TaskRunId } from '@runnets/domain';
import { prepareChatTools } from './chat-turn-tools.js';
/**
 * Shared single-turn execution.
 *
 * One implementation of create-task, cancel-before-dispatch, preparation,
 * dispatching, prepared, publication and failure/uncertainty rules. A direct
 * dialogue, broadcast child and marked room slice call it; no host forks these rules.
 */

import { taskRunId, validConversationText, type ChatTurn } from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type { Clock } from './ports.js';
import type { ChatMessage, ProviderPort } from './provider.js';
import type { TaskRunService } from './service.js';
import { cancelBeforeDispatch, ChatPreparationRefusal } from './chat-preparation.js';
import { updateChat } from './direct-chat-admission.js';
import { publishChat } from './direct-chat-publication.js';
import { runTurn } from './turn.js';
import type { TurnUpdate } from './turn-update.js';
import type { TurnInput } from './types.js';
import { publishKnownChatFailure, type ChatFailureEvidence } from './chat-known-failure.js';
import type { GrantedPluginTools, GrantedToolSource } from './plugin-turn-tools.js';

export type ChatCodingTools = NonNullable<TurnInput['tools']> & { readonly cleanupConfirmed: true };
export interface ChatTurnExecutionDeps extends ChatFailureEvidence {
  readonly tasks: TaskRunService;
  readonly store: ConversationStore;
  readonly clock: Clock;
  readonly sha256?: (text: string) => string;
  /** Absent for broadcast children: those never receive coding authority. */
  readonly codingTools?: { forTurn(turn: ChatTurn, signal: AbortSignal): Promise<ChatCodingTools> };
  /**
   * Task-independent granted plugin tools for normal (non-coding) room turns.
   * Broadcast children pass their own instance, so a child only ever sees its
   * own bot's grants.
   */
  readonly grantedTools?: {
    forTurn(turn: ChatTurn, signal: AbortSignal): Promise<GrantedPluginTools | null>;
  };
}
export type { GrantedPluginTools, GrantedToolSource };
export interface ChatTurnExecutionInput {
  readonly turn: ChatTurn;
  readonly messages: readonly ChatMessage[];
  readonly provider: ProviderPort | null;
  readonly signal: AbortSignal;
  readonly emit: (update: TurnUpdate) => void;
}
type RoomSliceExecution = Readonly<{
  parentRunId: TaskRunId | null;
  tools: GrantedPluginTools | null;
}>;
export async function executeChatTurn(
  deps: ChatTurnExecutionDeps,
  input: ChatTurnExecutionInput,
  room?: RoomSliceExecution,
): Promise<ChatTurn> {
  const { tasks, store, clock } = deps;
  let turn = input.turn;
  if (!!room !== !!turn.roomDelivery) throw Error('room execution marker mismatch');
  if (room && (!turn.activation || !input.provider)) throw Error('unsupported room scope');
  const id = taskRunId(turn.taskRunId);
  let preparationStarted = false,
    preparationSettled = turn.codingTaskId === undefined;
  const cancelled = async () => {
    if (room) {
      if (!input.signal.aborted || !deps.sha256) return null;
      const rootOwner = store.atomic((tx) => {
        const task = tx.roomTasks?.task(turn.roomDelivery!.taskId);
        const root = task && tx.roomTasks?.task(task.rootId);
        return root?.kind === 'root' ? root.rootPayload.ownerId : null;
      });
      if (
        !rootOwner ||
        !(await releaseUnstartedRoomClaim(
          { ...deps, sha256: deps.sha256, ownerId: rootOwner },
          turn.id,
        ))
      )
        return null;
      return store.atomic((tx) => tx.chatTurn(turn.id));
    }
    if (!(await cancelBeforeDispatch(tasks, turn, input.signal))) return null;
    const next = { ...turn, status: 'cancelled' as const };
    updateChat(store, turn, next);
    return next;
  };
  try {
    const created = await tasks.execute(createChatCommand(turn, room?.parentRunId ?? null));
    if (!created.ok) throw created.error;
    const early = await cancelled();
    if (early) return early;
    preparationStarted = turn.codingTaskId !== undefined;
    const tools = room
      ? turn.activation!.capabilities.tools
        ? combineChatTools(
            room.tools,
            turn.codingTaskId ? await deps.codingTools?.forTurn(turn, input.signal) : undefined,
            await deps.grantedTools?.forTurn(turn, input.signal),
          )
        : undefined
      : await prepareChatTools(deps, turn, input.signal);
    if (tools && tools.cleanupConfirmed !== true) throw Error('preparation cleanup unknown');
    preparationSettled = true;
    const afterPreparation = await cancelled();
    if (afterPreparation) return afterPreparation;
    const dispatched = { ...turn, status: 'dispatching' as const };
    if (room)
      store.atomic((tx) => {
        const current = tx.chatTurn(turn.id),
          rt = tx.roomTasks,
          marker = turn.roomDelivery!;
        const task = rt?.task(marker.taskId),
          delivery = rt?.delivery(marker.deliveryId),
          root = task && rt?.task(task.rootId);
        const evidence = rt?.unstartedEvidence(createChatCommand(turn, room.parentRunId)),
          effects = tx.chatFailureEvidence?.(turn.taskRunId);
        if (
          !current ||
          canonicalJson(current) !== canonicalJson(turn) ||
          current.status !== 'accepted' ||
          !task ||
          task.kind !== 'bot' ||
          task.status !== 'ready' ||
          !root ||
          root.kind !== 'root' ||
          !delivery ||
          delivery.state !== 'claimed' ||
          !roomSliceAuthority(tx, root, task, clock.now().getTime(), deps.sha256) ||
          !evidence ||
          evidence.kind !== 'created' ||
          evidence.run.parentTaskRunId !== room.parentRunId ||
          !effects ||
          effects.taskVersion !== 1 ||
          effects.relatedPendingEffects !== 0 ||
          clock.now().getTime() >= Date.parse(turn.activation!.deadlineAt)
        )
          throw Error('room executor claim held');
        tx.putChatTurn(dispatched);
      });
    else updateChat(store, turn, dispatched);
    turn = dispatched;
    const turnInput: TurnInput = {
      ...(room
        ? {
            authorizeModelDispatch: () =>
              store.atomic(
                (tx) =>
                  tx.roomTasks?.authorizeModel(turn.taskRunId, clock.now().getTime()) === true,
              ),
          }
        : {}),
      // Room continuations never inherit tool authority from a legacy CLI or ACP session.
      tools,
      service: tasks,
      provider: input.provider,
      taskRunId: id,
      model: turn.activation?.identity.modelId ?? turn.bot.model,
      ...(turn.activation === undefined ? {} : { activation: turn.activation }),
      clock,
      messages: input.messages,
      signal: input.signal,
      emit: input.emit,
      beforeComplete: async (text, stopReason) => {
        if (!validConversationText(text, 1048576)) throw new Error('Invalid final response');
        const state = await tasks.state(id);
        if (state.status !== 'running') throw new Error('chat task cannot prepare an answer');
        const prepared = {
          ...turn,
          status: 'prepared' as const,
          text,
          preparedVersion: state.version,
          stopReason,
        };
        updateChat(store, turn, prepared);
        turn = prepared;
      },
    };
    const outcome = room ? await runTurn(turnInput, { turnId: turn.id }) : await runTurn(turnInput);
    if (room) {
      if (outcome.kind === 'cancelled' && (await recordCancelledRoomTurn(deps, turn)))
        return store.atomic((tx) => tx.chatTurn(turn.id))!;
      const published = await repairRoomHandoff(deps, turn.id);
      if (published) return published;
      const saved = store.atomic((tx) => tx.chatTurn(turn.id));
      if (saved?.roomHandoff || saved?.status === 'prepared') return saved;
      if (!saved) throw Error('room turn missing');
      if (saved.status === 'dispatching') {
        const held = { ...saved, status: 'uncertain' as const };
        updateChat(store, saved, held);
        return held;
      }
      return saved;
    }
    if (outcome.kind === 'completed') return await publishChat(store, tasks, clock, turn);
    if (outcome.kind !== 'cancelled') {
      const failed = await publishKnownChatFailure(deps, turn);
      if (failed !== null) return failed;
    }
    // A dispatched stream failure can leave remote work or billing unknown.
    const next = {
      ...turn,
      status: outcome.kind === 'cancelled' ? ('cancelled' as const) : ('uncertain' as const),
      text: '',
    };
    updateChat(store, turn, next);
    return next;
  } catch (error) {
    if (room) {
      const saved = store.atomic((tx) => tx.chatTurn(turn.id));
      if (saved?.roomHandoff || saved?.status === 'prepared') {
        const repaired = await repairRoomHandoff(deps, turn.id);
        return repaired ?? saved;
      }
      // A losing executor never mutates the winning invocation's accepted/dispatching turn.
      throw error;
    }
    if (error instanceof ChatPreparationRefusal) preparationSettled = true;
    if (preparationSettled && turn.status !== 'prepared') {
      const beforeAttempt = await cancelled();
      if (beforeAttempt) return beforeAttempt;
    }
    // Prepared data is retained so local recovery can finish publication safely.
    if (turn.status !== 'prepared') {
      const next = {
        ...turn,
        status:
          turn.status === 'accepted' &&
          (!preparationStarted || error instanceof ChatPreparationRefusal)
            ? ('failed' as const)
            : ('uncertain' as const),
      };
      updateChat(store, turn, next);
    }
    throw error;
  }
}
