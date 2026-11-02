import { RemoteDecisions } from './remote-decisions.js';
import { randomUUID } from 'node:crypto';
import { RoomSubmission } from './room-submission.js';
import { visibleControls } from '../tui/decision-panel.js';
import { runView, type RunBookPort, type ScreenEntry, type BookOutcome } from '../tui/runs.js';
import type { RoomConnection } from './room-connection.js';
import { RemoteRoomView } from './remote-room-view.js';

export class RemoteChatRunBook implements RunBookPort {
  readonly #connection: RoomConnection;
  readonly #view: RemoteRoomView;
  readonly #submission: RoomSubmission;
  readonly #decisions: RemoteDecisions;
  get decisionPanel() {
    return this.#decisions.panel;
  }
  readonly #taskId: string | undefined;
  #sync: Promise<void> = Promise.resolve();
  #first = true;
  #redraw: (selection?: ScreenEntry) => void = () => {};
  constructor(connection: RoomConnection, roomId: string, taskId?: string) {
    this.#connection = connection;
    this.#view = new RemoteRoomView(roomId);
    this.#taskId = taskId;
    this.#submission = new RoomSubmission(connection, this.#view.scope, taskId);
    this.#decisions = new RemoteDecisions(connection, this.#view);
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
  async turn(_entry: ScreenEntry, prompt: string): Promise<BookOutcome> {
    const status = await this.#decisions.handle(prompt);
    if (status !== null) return { kind: 'notice', status };
    const receipt = await this.#submission.submit(prompt);
    await this.#refresh(false);
    this.#redraw(this.runs.find((e) => e.taskRunId === receipt.runId));
    return {
      kind: 'notice',
      status: receipt.runId
        ? 'admitted ' + receipt.runId
        : 'Message recorded without model dispatch',
    };
  }
  async cancel(entry?: ScreenEntry, submitting = false) {
    let target = entry?.remote;
    if (submitting) {
      const receipt = await this.#submission.active;
      if (!receipt?.runId) throw Error('Wait for the run receipt before cancelling');
      target =
        (await this.#connection.withClient((c) =>
          c.getRun({ ...this.#view.scope, runId: receipt.runId! }),
        )) ?? undefined;
    }
    if (!target) throw Error('no admitted run selected');
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
  watch(redraw: (selection?: ScreenEntry) => void, fail: (e: unknown) => void) {
    this.#redraw = redraw;
    void this.#observe().catch((e) => {
      if (!this.#connection.closed) fail(e);
    });
  }
  async #observe() {
    let cursor: string | undefined;
    while (!this.#connection.closed) {
      const observed = await this.#connection.withClient((c) =>
        c.observeRoom({ ...this.#view.scope, ...(cursor ? { cursor } : {}), waitMs: 750 }),
      );
      if (observed.kind !== 'timeout' || this.#view.active)
        await this.#refresh(observed.kind === 'resync');
      cursor = observed.cursor;
    }
  }
  #refresh(reset: boolean) {
    const sync = this.#sync.then(async () => {
      await this.#connection.withClient((c) => this.#view.refresh(c, reset));
      await this.#decisions.refresh();
      this.#redraw();
    });
    this.#sync = sync.catch(() => {});
    return sync;
  }
  detach() {
    this.#connection.close();
  }
}
