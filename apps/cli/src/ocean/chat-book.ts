import { RoomReviewController } from './room-review.js';
import { randomUUID } from 'node:crypto';
import { taskRunId, type TaskRunId } from '@runnets/domain';
import type { SessionUpdate } from '@runnets/contracts';
import type { ReviewApprovalPort, ProviderPort, TurnOutcome } from '@runnets/application';
import type { Runtime } from '../runtime.js';
import type { RunBookPort, RunEntry } from '../tui/runs.js';
import { runView } from '../tui/runs.js';
import type { StreamLine } from '../tui/types.js';

/** Adapt durable direct-room turns to the existing terminal renderer. */
export class ChatRunBook implements RunBookPort {
  readonly #runtime: Runtime;
  readonly #reviews: RoomReviewController;
  readonly #roomId: string;
  readonly #taskId: string | undefined;
  readonly #provider: ProviderPort | null;
  readonly #entries: RunEntry[] = [];
  #controller: AbortController | null = null;
  #cancelRequested = false;
  readonly #workspaceId = 'ws_ocean';
  #names = new Map<string, string>();
  model = '';
  providerId: string | null = null;
  constructor(runtime: Runtime, roomId: string, provider: ProviderPort | null, taskId?: string) {
    this.#runtime = runtime;
    this.#taskId = taskId;
    this.#reviews = new RoomReviewController(runtime, roomId);
    this.#roomId = roomId;
    this.#provider = provider;
  }
  setReviewApproval(approval: ReviewApprovalPort): void {
    this.#reviews.setApproval(approval);
  }
  get runs(): readonly RunEntry[] {
    return this.#entries;
  }
  views() {
    return this.#entries.map(runView);
  }
  entry(id: TaskRunId) {
    return this.#entries.find((e) => e.taskRunId === id);
  }
  /** Validate the selected room and show its persisted transcript before accepting input. */
  restore(): Promise<void> {
    const room = this.#runtime.conversations.room(this.#workspaceId, this.#roomId);
    if (!room.ok) throw new Error(room.error.code);
    const bots = this.#runtime.conversations.members(this.#workspaceId, this.#roomId);
    if (!bots.ok) throw new Error(bots.error.code);
    this.#names = new Map(bots.value.map((b) => [b.id, b.name]));
    this.model = bots.value.map((b) => '@' + b.handle + ' / ' + b.model).join(', ');
    this.providerId = room.value.kind === 'direct' ? (bots.value[0]?.provider ?? null) : 'group';
    return Promise.resolve();
  }
  /** New screen entry retains the same direct room; transcript comes from committed history. */
  add(_parent: TaskRunId | null): Promise<RunEntry> {
    const entry: RunEntry = {
      taskRunId: taskRunId('tr_draft_' + randomUUID().replaceAll('-', '')),
      aggregate: null,
      events: [],
      stream: this.#transcript(),
      liveMode: null,
    };
    this.#entries.push(entry);
    return Promise.resolve(entry);
  }
  async reload(entry: RunEntry): Promise<void> {
    entry.aggregate = await this.#runtime.service.state(entry.taskRunId);
    entry.events = await this.#runtime.service.events(entry.taskRunId);
  }
  openForTurn(entry: RunEntry): Promise<RunEntry> {
    return entry.aggregate?.status === 'absent'
      ? Promise.resolve(entry)
      : this.add(entry.taskRunId);
  }
  async turn(
    entry: RunEntry,
    prompt: string,
    emit: (update: SessionUpdate) => void,
  ): Promise<TurnOutcome> {
    const controller = new AbortController();
    this.#controller = controller;
    if (this.#cancelRequested) {
      this.#cancelRequested = false;
      controller.abort();
    }
    entry.stream = [...this.#transcript(), { kind: 'user', text: prompt }];
    try {
      const notice = await this.#reviews.handle(prompt, controller.signal);
      if (notice !== null) {
        entry.stream = [...this.#transcript(), { kind: 'text', label: 'Ocean', text: notice }];
        return { kind: 'completed', text: notice, stopReason: 'end_turn' };
      }
      const result = await this.#runtime.chat.send({
        workspaceId: this.#workspaceId,
        roomId: this.#roomId,
        requestId: randomUUID(),
        text: prompt,
        ...(this.#taskId === undefined ? {} : { taskId: this.#taskId }),
        provider: this.#provider,
        signal: controller.signal,
        emit,
        onAdmitted: (turn) => {
          entry.taskRunId = taskRunId(turn.taskRunId);
          this.model = '@' + turn.bot.handle + ' / ' + turn.bot.model;
          this.providerId = turn.bot.provider;
        },
      });
      if (!result.ok) throw new Error(result.error.code);
      entry.stream = this.#transcript();
      const turn = result.value;
      if (turn.status === 'recorded')
        return {
          kind: 'completed',
          text: 'Message recorded without model dispatch',
          stopReason: 'end_turn',
        };
      if (turn.status === 'completed')
        return { kind: 'completed', text: turn.text, stopReason: turn.stopReason };
      if (turn.status === 'cancelled')
        return { kind: 'cancelled', text: '', stopReason: 'cancelled' };
      return {
        kind: 'uncertain',
        text: 'Inspect interrupted execution before retrying',
        stopReason: 'refusal',
      };
    } finally {
      this.#controller = null;
    }
  }
  cancel(): void {
    if (this.#controller === null) this.#cancelRequested = true;
    else this.#controller.abort();
  }
  #transcript(): readonly StreamLine[] {
    const lines: StreamLine[] = [];
    let after = 0;
    for (;;) {
      const result = this.#runtime.conversations.history(
        this.#workspaceId,
        this.#roomId,
        after,
        200,
      );
      if (!result.ok) throw new Error(result.error.code);
      for (const message of result.value)
        lines.push({
          kind: message.author === 'bot' ? 'text' : 'user',
          text: message.body,
          ...(message.author === 'bot'
            ? { label: this.#names.get(message.authorBotId ?? '') ?? 'Bot' }
            : {}),
        });
      if (result.value.length < 200) break;
      after = result.value.at(-1)?.seq ?? after;
    }
    return lines;
  }
}
