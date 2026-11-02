/**
 * Runtime session behind the terminal UI.
 *
 * The UI itself holds no domain decisions: this module creates TaskRuns with
 * the same commands and turn engine the ACP host uses, keeps one conversation
 * per run (inherited by a continuation run), and returns committed snapshots
 * for rendering.
 */

import type { ToolService, TaskRunService } from '@runnets/application';
import type { SessionUpdate } from '@runnets/contracts';
import {
  conversationId as brandConversationId,
  policyId as brandPolicyId,
  taskRunId as brandTaskRunId,
  unlimitedBudget,
  replay,
  workspaceId as brandWorkspaceId,
  type EventEnvelope,
  type TaskRunAggregate,
  type TaskRunId,
} from '@runnets/domain';
import type { ProviderPort } from '@runnets/provider-core';

import { executeStep } from '../engine/commands.js';
import { Conversation } from '../engine/conversation.js';
import { runTurn } from '../engine/turn.js';
import type { TurnOutcome } from '../engine/types.js';

/** Model advertised when no provider is configured. */
export const LOCAL_MODEL = 'runnets-local';

export interface RunSnapshot {
  readonly aggregate: TaskRunAggregate;
  readonly events: readonly EventEnvelope[];
}

export interface SendTurnInput {
  readonly taskRunId: TaskRunId;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly emit: (update: SessionUpdate) => void;
}

export interface TuiSessionOptions {
  readonly tools?: ToolService | undefined;
  readonly service: TaskRunService;
  readonly provider: ProviderPort | null;
}

export class TuiSession {
  readonly #service: TaskRunService;
  readonly #provider: ProviderPort | null;
  readonly #tools: ToolService | undefined;
  readonly #conversations = new Map<TaskRunId, Conversation>();
  #runCount = 0;

  constructor(options: TuiSessionOptions) {
    this.#service = options.service;
    this.#provider = options.provider;
    this.#tools = options.tools;
  }

  get model(): string {
    return this.#provider?.models[0] ?? LOCAL_MODEL;
  }

  get providerId(): string | null {
    return this.#provider?.id ?? null;
  }

  /**
   * Commit `CreateTaskRun` for a new session run and return its id.
   *
   * A continuation run inherits the parent's conversation so the prompt keeps
   * its history after the parent reached a terminal state.
   */
  async createRun(parentTaskRunId: TaskRunId | null): Promise<TaskRunId> {
    this.#runCount += 1;
    let suffix = String(this.#runCount).padStart(4, '0');
    let taskRunId = brandTaskRunId(`tr_tui_${suffix}`);
    // A restarted host must not reuse a persisted run's creation receipt.
    while ((await this.#service.state(taskRunId)).status !== 'absent') {
      this.#runCount += 1;
      suffix = String(this.#runCount).padStart(4, '0');
      taskRunId = brandTaskRunId(`tr_tui_${suffix}`);
    }
    if (parentTaskRunId !== null && !this.#conversations.has(parentTaskRunId))
      throw new Error('Conversation history unavailable; use /new for an independent task');
    const parentConversation =
      parentTaskRunId === null ? undefined : this.#conversations.get(parentTaskRunId);

    const result = await executeStep(
      this.#service,
      taskRunId,
      'CreateTaskRun',
      {
        conversationId: brandConversationId(`cv_tui_${suffix}`),
        workspaceId: brandWorkspaceId(`ws_tui_${suffix}`),
        parentTaskRunId,
        model: this.model,
        policyId: brandPolicyId('pl_default'),
        budget: unlimitedBudget(),
      },
      0,
    );
    if (!result.ok) throw result.error;
    this.#conversations.set(taskRunId, parentConversation ?? new Conversation());
    return taskRunId;
  }

  /** Committed projection plus event stream for one run. */
  async snapshot(taskRunId: TaskRunId): Promise<RunSnapshot> {
    const events = await this.#service.events(taskRunId);
    return { aggregate: replay(events), events };
  }

  /** Run one turn, streaming session updates to the caller's sink. */
  async sendTurn(input: SendTurnInput): Promise<TurnOutcome> {
    const conversation = this.#conversationOf(input.taskRunId);
    conversation.appendUser(input.prompt);
    const outcome = await runTurn({
      service: this.#service,
      tools: this.#tools,
      onHistory: (messages) => conversation.appendMessages(messages),
      provider: this.#provider,
      taskRunId: input.taskRunId,
      model: this.model,
      messages: conversation.messages,
      signal: input.signal,
      emit: input.emit,
    });

    return outcome;
  }

  #conversationOf(taskRunId: TaskRunId): Conversation {
    const existing = this.#conversations.get(taskRunId);
    if (existing !== undefined) return existing;
    throw new Error('Conversation history unavailable; inspect effects and use /new');
  }
}
