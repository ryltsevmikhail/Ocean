/**
 * Session run book for the terminal UI.
 *
 * Holds the runs created by this TUI session, their committed projections and
 * live stream lines, and the single in-flight turn. The app above it only
 * translates keys and paints frames; this module owns the calls into the
 * runtime.
 */

import {
  selectTurnTask,
  type ReviewApprovalPort,
  type ToolService,
  type TaskRunService,
} from '@runnets/application';
import type { SessionUpdate } from '@runnets/contracts';
import { type EventEnvelope, type TaskRunAggregate, type TaskRunId } from '@runnets/domain';
import type { ProviderPort } from '@runnets/provider-core';

import type { TurnOutcome } from '../engine/types.js';
import { TuiSession } from './session.js';
import { appendStream } from './state.js';
import type { StreamLine } from './types.js';
import type { RunViewData } from './view.js';

export interface RunEntry {
  taskRunId: TaskRunId;
  aggregate: TaskRunAggregate | null;
  events: readonly EventEnvelope[];
  stream: readonly StreamLine[];
  liveMode: string | null;
  codingLines?: readonly string[];
}

export interface RunBookOptions {
  readonly recovered?: readonly TaskRunId[] | undefined;
  readonly tools?: ToolService | undefined;
  readonly service: TaskRunService;
  readonly provider: ProviderPort | null;
}

/** Human status line for a finished turn. */
export function turnStatus(outcome: TurnOutcome): string {
  switch (outcome.kind) {
    case 'completed':
      return `turn completed (${outcome.stopReason})`;
    case 'failed':
      return `turn failed (${outcome.stopReason})`;
    case 'uncertain':
      return 'outcome unknown — inspect effects; automatic retry blocked';
    case 'cancelled':
      return 'turn cancelled';
  }
}

/** Read-only projection of an entry for the renderer. */
export function runView(entry: RunEntry): RunViewData {
  return {
    taskRunId: entry.taskRunId,
    aggregate: entry.aggregate,
    events: entry.events,
    stream: entry.stream,
    liveMode: entry.liveMode,
    ...(entry.codingLines === undefined ? {} : { codingLines: entry.codingLines }),
  };
}

/**
 * Fold one session update into the entry: provider deltas accumulate in the
 * live stream, and the committed mode id is shown while a turn is running.
 */
export function applyUpdate(entry: RunEntry, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type === 'text') {
        entry.stream = appendStream(entry.stream, 'text', update.content.text);
      }
      break;
    case 'agent_thought_chunk':
      if (update.content.type === 'text') {
        entry.stream = appendStream(entry.stream, 'thought', update.content.text);
      }
      break;
    case 'current_mode_update':
      entry.liveMode = update.currentModeId;
      break;
    case 'user_message_chunk':
      break;
    case 'tool_call':
      entry.stream = [
        ...entry.stream,
        {
          kind: 'tool',
          id: update.toolCallId,
          status: update.status ?? 'pending',
          text: update.title,
        },
      ];
      break;
    case 'tool_call_update':
      entry.stream = entry.stream.map((line) =>
        line.id !== update.toolCallId
          ? line
          : {
              ...line,
              status: update.status ?? line.status ?? 'pending',
              text: `${line.text.split('\n')[0] ?? ''}\n${update.content?.map((item) => (item.type === 'content' && item.content.type === 'text' ? item.content.text : '')).join('') ?? ''}`,
            },
      );
      break;
    case 'plan':
    case 'config_option_update':
      break;
  }
}

export class RunBook {
  readonly #session: TuiSession;
  readonly #service: TaskRunService;
  readonly #entries: RunEntry[] = [];
  #turnAbort: AbortController | null = null;
  #cancelRequested = false;
  readonly #recovered: readonly TaskRunId[];

  constructor(options: RunBookOptions) {
    this.#recovered = options.recovered ?? [];
    this.#service = options.service;
    this.#session = new TuiSession({
      service: options.service,
      provider: options.provider,
      tools: options.tools,
    });
  }

  get model(): string {
    return this.#session.model;
  }

  get providerId(): string | null {
    return this.#session.providerId;
  }

  get runs(): readonly RunEntry[] {
    return this.#entries;
  }

  views(): readonly RunViewData[] {
    return this.#entries.map(runView);
  }

  entry(taskRunId: TaskRunId): RunEntry | undefined {
    return this.#entries.find((entry) => entry.taskRunId === taskRunId);
  }

  /** Recovered entries expose committed state without inventing lost conversation context. */
  async restore(): Promise<void> {
    for (const taskRunId of this.#recovered) {
      const entry: RunEntry = {
        taskRunId,
        aggregate: null,
        events: [],
        liveMode: null,
        stream: [
          {
            kind: 'text',
            text: 'Interrupted execution: history unavailable. Inspect effects; automatic continuation is blocked. Use /new for a separate task.',
          },
        ],
      };
      await this.reload(entry);
      this.#entries.push(entry);
    }
  }

  /** Create a run and register it; the caller decides when to load it. */
  async add(parentTaskRunId: TaskRunId | null): Promise<RunEntry> {
    const taskRunId = await this.#session.createRun(parentTaskRunId);
    const entry: RunEntry = {
      taskRunId,
      aggregate: null,
      events: [],
      stream: parentTaskRunId === null ? [] : [...(this.entry(parentTaskRunId)?.stream ?? [])],
      liveMode: null,
    };
    this.#entries.push(entry);
    return entry;
  }

  /** Reload the committed projection and event stream of one run. */
  async reload(entry: RunEntry): Promise<void> {
    const snapshot = await this.#session.snapshot(entry.taskRunId);
    if ((entry.aggregate?.version ?? 0) <= snapshot.aggregate.version) {
      entry.aggregate = snapshot.aggregate;
      entry.events = snapshot.events;
    }
  }

  /**
   * A terminal run accepts no further commands, so a prompt needs a
   * continuation run that inherits its conversation. Returns the run to use.
   */
  async openForTurn(entry: RunEntry): Promise<RunEntry> {
    const id = await selectTurnTask(
      this.#service,
      entry.taskRunId,
      async () => (await this.add(entry.taskRunId)).taskRunId,
    );
    const target = this.entry(id);
    if (target === undefined) throw new Error('turn target was not registered');
    await this.reload(target);
    return target;
  }

  /** Run one turn; cancellation aborts the provider stream through the signal. */
  async turn(
    entry: RunEntry,
    prompt: string,
    emit: (update: SessionUpdate) => void,
  ): Promise<TurnOutcome> {
    entry.stream = appendStream(entry.stream, 'user', prompt);
    const controller = new AbortController();
    this.#turnAbort = controller;
    if (this.#cancelRequested) {
      this.#cancelRequested = false;
      controller.abort();
    }
    try {
      return await this.#session.sendTurn({
        taskRunId: entry.taskRunId,
        prompt,
        signal: controller.signal,
        emit,
      });
    } finally {
      if (this.#turnAbort === controller) this.#turnAbort = null;
    }
  }

  /** Abort the in-flight turn, or arm cancellation for the next one. */
  cancel(): void {
    if (this.#turnAbort !== null) {
      this.#turnAbort.abort();
      return;
    }
    this.#cancelRequested = true;
  }
}

export type RunBookPort = Pick<
  RunBook,
  | 'model'
  | 'providerId'
  | 'runs'
  | 'views'
  | 'entry'
  | 'restore'
  | 'add'
  | 'reload'
  | 'openForTurn'
  | 'turn'
  | 'cancel'
> & {
  loadChangeset?: (entry: RunEntry) => Promise<void>;
  setReviewApproval?: (approval: ReviewApprovalPort) => void;
};
