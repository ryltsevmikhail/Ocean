import {
  validConversationText,
  conversationId,
  workspaceId,
  taskRunId,
  unlimitedBudget,
  ok,
  type ChatTurn,
  type ConversationResult,
} from '@runnets/domain';
import { admitChat, updateChat, type DirectChatRequest } from './direct-chat-admission.js';
import { publishChat, recoverChats } from './direct-chat-publication.js';
import type { ConversationServiceDeps } from './conversations.js';
import type { TaskRunService } from './service.js';
import type { ProviderPort } from './provider.js';
import type { TurnUpdate } from './turn-update.js';
import { executeStep } from './commands.js';
import { runTurn } from './turn.js';

export interface RecordedRoomMessage {
  readonly status: 'recorded';
  readonly roomId: string;
  readonly messageId: string;
  readonly taskRunId: null;
}
export interface DirectChatDeps extends ConversationServiceDeps {
  readonly tasks: TaskRunService;
}
export interface SendDirectInput extends DirectChatRequest {
  readonly provider: ProviderPort | null;
  readonly signal: AbortSignal;
  readonly emit: (update: TurnUpdate) => void;
  readonly onAdmitted?: (turn: ChatTurn) => void;
}
/** One host-neutral direct dialogue path for CLI and TUI, reconstructed from committed history. */
export class DirectChatService {
  readonly #deps: DirectChatDeps;
  constructor(deps: DirectChatDeps) {
    this.#deps = deps;
  }
  /** A request receipt can observe a turn, but can never authorize another dispatch. */
  async send(input: SendDirectInput): Promise<ConversationResult<ChatTurn | RecordedRoomMessage>> {
    const admitted = admitChat(this.#deps, input, input.provider);
    if (!admitted.ok) return admitted;
    if ('record' in admitted.value)
      return ok({
        status: 'recorded',
        roomId: admitted.value.record.roomId,
        messageId: admitted.value.record.id,
        taskRunId: null,
      });
    let turn = admitted.value.turn;
    input.onAdmitted?.(turn);
    if (!admitted.value.fresh) return ok(turn);
    const { tasks, store, clock } = this.#deps;
    const id = taskRunId(turn.taskRunId);
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
          model: turn.bot.model,
          policyId: 'pl_ocean',
          budget: unlimitedBudget(),
        },
      });
      if (!created.ok) throw created.error;
      if (input.signal.aborted) {
        const cancel = await executeStep(
          tasks,
          id,
          'RequestCancel',
          { cause: 'client cancelled' },
          created.value.version,
        );
        if (!cancel.ok) throw cancel.error;
        const cleaned = await executeStep(
          tasks,
          id,
          'CompleteCleanup',
          { cleanup: 'completed' },
          cancel.value.version,
        );
        if (!cleaned.ok) throw cleaned.error;
        const next = { ...turn, status: 'cancelled' as const };
        updateChat(store, turn, next);
        return ok(next);
      }
      const dispatched = { ...turn, status: 'dispatching' as const };
      updateChat(store, turn, dispatched);
      turn = dispatched;
      const outcome = await runTurn({
        // Room continuations never inherit tool authority from a legacy CLI or ACP session.
        tools: undefined,
        service: tasks,
        provider: input.provider,
        taskRunId: id,
        model: turn.bot.model,
        messages: admitted.value.messages,
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
      if (outcome.kind === 'completed') return ok(await publishChat(store, tasks, clock, turn));
      // A dispatched stream failure can leave remote work or billing unknown.
      const next = {
        ...turn,
        status: outcome.kind === 'cancelled' ? ('cancelled' as const) : ('uncertain' as const),
        text: '',
      };
      updateChat(store, turn, next);
      return ok(next);
    } catch (error) {
      // Prepared data is retained so local recovery can finish publication safely.
      if (turn.status !== 'prepared') {
        const next = {
          ...turn,
          status: turn.status === 'accepted' ? ('failed' as const) : ('uncertain' as const),
        };
        updateChat(store, turn, next);
      }
      throw error;
    }
  }
  /** Requires exclusive host ownership. Never replays a provider or tool request. */
  recover(): Promise<void> {
    return recoverChats(this.#deps.store, this.#deps.tasks, this.#deps.clock);
  }
}
