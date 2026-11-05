/**
 * Shared single-turn execution.
 *
 * One implementation of create-task, cancel-before-dispatch, preparation,
 * dispatching, prepared, publication and failure/uncertainty rules. A direct
 * dialogue and a broadcast child both call it; no host forks these rules.
 */

import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  validConversationText,
  workspaceId,
  type ChatTurn,
} from '@runnets/domain';
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
export async function executeChatTurn(
  deps: ChatTurnExecutionDeps,
  input: ChatTurnExecutionInput,
): Promise<ChatTurn> {
  const { tasks, store, clock } = deps;
  let turn = input.turn;
  const id = taskRunId(turn.taskRunId);
  let preparationStarted = false,
    preparationSettled = turn.codingTaskId === undefined;
  const cancelled = async () => {
    if (!(await cancelBeforeDispatch(tasks, turn, input.signal))) return null;
    const next = { ...turn, status: 'cancelled' as const };
    updateChat(store, turn, next);
    return next;
  };
  try {
    const created = await tasks.execute({
      type: 'CreateTaskRun',
      commandId: 'chat-create-' + turn.id,
      taskRunId: id,
      expectedVersion: 0,
      actor: { kind: 'user', id: 'owner' },
      payload: {
        conversationId: conversationId('cv_' + turn.roomId),
        workspaceId: workspaceId('ws_' + turn.workspaceId),
        parentTaskRunId: null,
        model: turn.activation?.identity.modelId ?? turn.bot.model,
        policyId: 'pl_ocean',
        budget: unlimitedBudget(),
      },
    });
    if (!created.ok) throw created.error;
    const early = await cancelled();
    if (early) return early;
    preparationStarted = turn.codingTaskId !== undefined;
    const tools =
      turn.codingTaskId === undefined
        ? ((await deps.grantedTools?.forTurn(turn, input.signal)) ?? undefined)
        : await deps.codingTools!.forTurn(turn, input.signal);
    if (tools && tools.cleanupConfirmed !== true) throw Error('preparation cleanup unknown');
    preparationSettled = true;
    const afterPreparation = await cancelled();
    if (afterPreparation) return afterPreparation;
    const dispatched = { ...turn, status: 'dispatching' as const };
    updateChat(store, turn, dispatched);
    turn = dispatched;
    const outcome = await runTurn({
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
    });
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
