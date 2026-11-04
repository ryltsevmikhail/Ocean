import { RemoteDecisions, roomCommand } from './remote-decisions.js';
import type { LocalRunSnapshot, LocalTurnReceipt } from '@runnets/contracts';
import { randomUUID } from 'node:crypto';
import { RoomSubmission } from './room-submission.js';
import { visibleControls } from '../tui/decision-panel.js';
import { runView, type RunBookPort, type ScreenEntry, type BookOutcome } from '../tui/runs.js';
import type { RoomConnection } from './room-connection.js';
import { RemoteRoomView } from './remote-room-view.js';
import { RemoteBroadcast } from './remote-broadcast.js';
import { parseBroadcastPrompt } from './broadcast-prompt.js';

export class RemoteChatRunBook implements RunBookPort {
  readonly #connection: RoomConnection;
  readonly #view: RemoteRoomView;
  readonly #submission: RoomSubmission;
  readonly #decisions: RemoteDecisions;
  readonly #broadcast: RemoteBroadcast;
  get decisionPanel() {
    return this.#decisions.panel;
  }
  readonly #taskId: string | undefined;
  #sync: Promise<void> = Promise.resolve();
  #first = true;
  #resyncAt = 0;
  #confirmed: { prompt: string; receipt: LocalTurnReceipt } | null = null;
  #redraw: (selection?: ScreenEntry) => void = () => {};
  constructor(connection: RoomConnection, roomId: string, taskId?: string) {
    this.#connection = connection;
    this.#view = new RemoteRoomView(roomId);
    this.#taskId = taskId;
    this.#submission = new RoomSubmission(connection, this.#view.scope, taskId);
    this.#decisions = new RemoteDecisions(connection, this.#view);
    this.#broadcast = new RemoteBroadcast(connection, this.#view.scope);
  }
  get workspace() {
    return this.#view.workspace;
  }
  get model() {
    return this.#view.model;
  }
  get providerId() {
    return this.#view.providerId;
  }
  get runs() {
    return this.#view.entries;
  }
  views() {
    return this.runs.map(runView);
  }
  async restore() {
    await this.#connection.withClient((c) => this.#view.restore(c));
    await this.#refresh(true);
  }
  add() {
    const entry = this.#first ? this.#view.latest() : undefined;
    this.#first = false;
    return Promise.resolve(entry ?? this.#view.draft());
  }
  async loadChangeset(entry: ScreenEntry) {
    const taskId = this.#taskId;
    entry.codingLines = taskId
      ? (
          await this.#connection.withClient((c) => c.codingPanel({ ...this.#view.scope, taskId }))
        ).map(visibleControls)
      : ['No coding task selected. Start TUI with --task TASK.'];
  }
  holdDraft(prompt: string) {
    if (this.#confirmed && this.#confirmed.prompt !== prompt && roomCommand(prompt) === null)
      return 'Draft kept. Press Enter again after the previous message appears in history.';
    return undefined;
  }
  batchStatus(): string {
    return this.#broadcast.status();
  }
  async turn(_entry: ScreenEntry, prompt: string): Promise<BookOutcome> {
    const broadcast = await this.#broadcastCommand(prompt);
    if (broadcast !== null) return { kind: 'notice', status: broadcast };
    const status = await this.#decisions.handle(prompt);
    if (status !== null) return { kind: 'notice', status };
    const hold = this.holdDraft(prompt);
    if (hold) return { kind: 'notice', status: hold };
    const receipt = this.#confirmed?.receipt ?? (await this.#submission.submit(prompt));
    this.#confirmed = { prompt, receipt };
    const selection = this.#view.confirm(receipt);
    this.#redraw(selection);
    return {
      kind: 'notice',
      status: receipt.runId
        ? 'admitted ' + receipt.runId
        : 'Message recorded without model dispatch · ' + receipt.messageId,
    };
  }
  /** Explicit broadcast actions; the same durable DTO backs every client. */
  async #broadcastCommand(prompt: string): Promise<string | null> {
    const action = parseBroadcastPrompt(prompt);
    if (action === null) return null;
    if (action.kind === 'show') {
      await this.#refresh(false);
      return this.#broadcast.status() || 'В этой комнате нет рассылки.';
    }
    if (action.kind === 'vote') {
      const batch =
        action.action === 'continue'
          ? await this.#broadcast.continue(action.batchId, action.expectedRevision)
          : await this.#broadcast.abandon(action.batchId, action.expectedRevision);
      await this.#refresh(false);
      return `Рассылка ${batch.id}: ${batch.state} · ревизия ${batch.revision}`;
    }
    const batch = await this.#broadcast.submit(action.text);
    await this.#refresh(false);
    return `Рассылка принята: ${batch.id} · ${batch.recipients.length} участников`;
  }
  async cancel(target?: LocalRunSnapshot) {
    if (!target) throw Error('Show the full admitted run ID and version before cancelling');
    const command = {
      ...this.#view.scope,
      runId: target.runId,
      expectedVersion: target.version,
      requestId: randomUUID(),
    };
    await this.#connection.withClient((c) => c.cancelRun(command));
    await this.#refresh(false);
    return 'Cancellation requested';
  }
  watch(redraw: (selection?: ScreenEntry) => void) {
    this.#redraw = redraw;
    void this.#observe().catch((e) => {
      if (this.#connection.closed) return;
      this.#view.observationError(
        'Room observation stopped: ' + (e instanceof Error ? e.message : 'read failed'),
      );
      this.#redraw();
    });
  }
  async #observe() {
    let cursor: string | undefined;
    let reset = false;
    while (!this.#connection.closed) {
      try {
        const observed = await this.#connection.withClient((c) =>
          c.observeRoom({ ...this.#view.scope, ...(cursor ? { cursor } : {}), waitMs: 750 }),
        );
        const resync = Date.now() >= this.#resyncAt;
        if (observed.kind !== 'timeout' || this.#view.active || this.#confirmed || reset || resync)
          await this.#refresh(
            reset || observed.kind === 'resync' || resync,
            observed.kind !== 'timeout',
          );
        cursor = observed.cursor;
        reset = false;
      } catch (e) {
        if (this.#connection.closed) return;
        if (!(
          e instanceof Error &&
          ['invalid_frame', 'runtime_failure', 'resync_required', 'runtime_draining'].includes(
            e.message,
          )
        ))
          throw e;
        this.#view.observationError('Room observation failed: ' + e.message + '. Retrying reads.');
        this.#redraw();
        reset = true;
        await this.#connection.pause();
      }
    }
  }
  #refresh(reset: boolean, changed = true) {
    const sync = this.#sync.then(async () => {
      await this.#connection.withClient((c) => this.#view.refresh(c, reset));
      await this.#broadcast.refresh();
      await this.#decisions.refresh(reset || changed);
      if (reset) this.#resyncAt = Date.now() + 30000;
      this.#view.observationError('');
      if (this.#confirmed && this.#view.observed(this.#confirmed.receipt)) this.#confirmed = null;
      this.#redraw();
    });
    this.#sync = sync.catch(() => {});
    return sync;
  }
  detach() {
    this.#connection.close();
  }
}
