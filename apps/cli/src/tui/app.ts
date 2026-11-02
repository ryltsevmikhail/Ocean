import { TuiPending } from './pending.js';
import { refreshChangeset, messageOf } from './changeset.js';
/** Terminal input and rendering; RunBook composes the runtime and turn engine. */

import type { Readable, Writable } from 'node:stream';

import type { SessionUpdate } from '@runnets/contracts';
import type { TaskRunId } from '@runnets/domain';

import { createRunBook } from './book.js';
import { TuiApproval } from './approval.js';
import type { Key } from './keys.js';
import { KeyInput } from './input.js';
import { applyUpdate, runView, turnStatus, type ScreenEntry, type RunBookPort } from './runs.js';
import { initialUiState, reduceKey, type UiState } from './state.js';
import { Terminal } from './terminal.js';
import type { TuiAppOptions } from './options.js';
export type { TuiAppOptions } from './options.js';
import {
  renderFrame,
  navigationContext,
  anchorDialogue,
  type FrameInput,
  type RunViewData,
} from './view.js';

export class TuiApp {
  readonly #input: Readable;
  readonly #workspace: string | undefined;
  readonly #output: Writable;
  readonly #terminal: Terminal;
  readonly #book: RunBookPort;
  readonly #approval: TuiApproval;
  readonly #dataHandler: (chunk: Buffer | string) => void;
  readonly #endHandler: () => void;
  readonly #resizeHandler: () => void;
  readonly #exitPromise: Promise<void>;
  #resolveExit: () => void = () => {};
  #ui: UiState = initialUiState();
  readonly #keys = new KeyInput((keys) => this.#onKeys(keys));
  #batching = false;
  readonly #pending = new TuiPending();
  #started = false;
  #stopped = false;

  constructor(options: TuiAppOptions) {
    this.#input = options.input;
    this.#workspace = options.workspace;
    this.#output = options.output;
    this.#terminal = new Terminal({
      input: options.input,
      output: options.output,
      fallbackSize: options.size ?? { columns: 100, rows: 30 },
    });
    this.#approval = new TuiApproval(() => this.#redraw());
    this.#book = createRunBook(options, this.#approval);
    this.#dataHandler = (chunk) => this.#keys.read(chunk);
    this.#endHandler = () => this.stop();
    this.#resizeHandler = () => this.#redraw();
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  /** Enter the terminal, attach streams and create the first run of the session. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#terminal.enter();
    this.#input.on('data', this.#dataHandler);
    this.#input.on('end', this.#endHandler);
    this.#output.on('resize', this.#resizeHandler);
    this.#redraw();
    await this.#book.restore();
    await this.#createRun(null);
    if (!this.#stopped)
      this.#book.watch?.(
        (selection) => {
          if (selection)
            this.#ui = { ...this.#ui, selectedIndex: this.#book.runs.indexOf(selection) };
          this.#redraw();
        },
        (e) => this.#fail(e),
      );
  }

  /** Restore the terminal and detach listeners; safe to call more than once. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#book.detach) this.#book.detach();
    else this.#cancelTurn();
    this.#input.off('data', this.#dataHandler);
    this.#input.off('end', this.#endHandler);
    this.#input.pause();
    this.#keys.close();
    this.#output.off('resize', this.#resizeHandler);
    this.#terminal.leave();
    this.#resolveExit();
  }

  /** Resolves once the UI has quit. */
  whenExit(): Promise<void> {
    return this.#exitPromise;
  }

  get ui(): UiState {
    return this.#ui;
  }

  get runCount(): number {
    return this.#book.runs.length;
  }

  /** Current screen, exactly as it would be drawn; used by tests and diagnostics. */
  frame(): string {
    return (
      this.#book.decisionPanel?.frame(this.#terminal.size()) ??
      this.#approval.frame(this.#terminal.size()) ??
      renderFrame(this.#frameInput())
    );
  }

  selectedRun(): RunViewData | null {
    const entry = this.#book.runs[this.#ui.selectedIndex];
    return entry === undefined ? null : runView(entry);
  }

  /** Await every pending runtime action, including cancellation settlement. */
  idle() {
    return this.#pending.idle();
  }

  #onKeys(keys: readonly Key[]): void {
    if (this.#stopped) return;
    this.#batching = true;
    try {
      for (const key of keys) this.#handleKey(key);
    } finally {
      this.#batching = false;
      this.#redraw();
    }
  }

  #handleKey(key: Key): void {
    if (this.#stopped || this.#approval.handle(key)) return;
    const decision = this.#book.decisionPanel?.handle(key, this.#terminal.ownerInteractive);
    if (decision) {
      if (decision instanceof Promise) this.#track(decision.finally(() => this.#redraw()));
      return;
    }
    const transition = reduceKey(this.#ui, key, {
      runCount: this.#book.runs.length,
      detachOnQuit: this.#book.detach !== undefined,
      remoteActive: ['accepted', 'dispatching', 'prepared'].includes(
        this.selectedRun()?.remote?.turnStatus ?? '',
      ),
      ...navigationContext(this.#frameInput()),
    });
    this.#ui = transition.state;
    if (key.type === 'panel' && key.panel === 'changeset')
      this.#track(
        refreshChangeset(this.#book, this.#book.runs[this.#ui.selectedIndex], () => this.#redraw()),
      );
    switch (transition.action.type) {
      case 'quit':
        this.stop();
        return;
      case 'cancel-turn':
        this.#cancelTurn();
        break;
      case 'create-run':
        this.#track(this.#createRun(null));
        break;
      case 'send-turn':
        this.#sendTurn(transition.action.prompt);
        break;
      case 'none':
        break;
    }
    this.#redraw();
  }

  #sendTurn(prompt: string): void {
    if (this.#ui.busy) {
      this.#setStatus('a turn is already running');
      return;
    }
    const entry = this.#book.runs[this.#ui.selectedIndex];
    if (entry === undefined) {
      this.#setStatus('no run selected — press n to create one');
      return;
    }
    this.#ui = {
      ...this.#ui,
      busy: true,
      status: this.#book.detach ? 'submitting…' : `turn started on ${entry.taskRunId}`,
    };
    this.#track(this.#performTurn(entry, prompt));
  }

  async #performTurn(entry: ScreenEntry, prompt: string): Promise<void> {
    let target = entry;
    await this.#loadEntry(target);
    const opened = (await this.#book.openForTurn?.(target)) ?? target;
    if (opened !== target) {
      // The continuation run is a new list row; show it as the selection.
      this.#ui = {
        ...this.#ui,
        selectedIndex: this.#book.runs.length - 1,
        eventScroll: 0,
        dialogScroll: 0,
      };
      target = opened;
      this.#ui = { ...this.#ui, status: `working on ${target.taskRunId}` };
      this.#redraw();
    }

    try {
      const outcome = await this.#book.turn(target, prompt, (update) => {
        this.#onUpdate(target, update);
      });
      this.#ui = { ...this.#ui, busy: false, status: turnStatus(outcome) };
      target.liveMode = null;
      await this.#loadEntry(target);
    } finally {
      this.#ui = { ...this.#ui, busy: false };
      this.#redraw();
    }
  }

  #onUpdate(entry: ScreenEntry, update: SessionUpdate): void {
    const previous = entry.stream;
    applyUpdate(entry, update);
    if (this.#book.runs[this.#ui.selectedIndex] === entry)
      this.#ui = anchorDialogue(this.#ui, previous, entry.stream, this.#terminal.size().columns);
    if (update.sessionUpdate === 'current_mode_update')
      this.#track(
        this.#loadEntry(entry).catch(() => this.#setStatus('could not refresh task details')),
      );
    this.#redraw();
  }

  #cancelTurn(): void {
    const result = this.#book.cancel(this.#book.runs[this.#ui.selectedIndex], this.#ui.busy);
    if (result) this.#track(result.then((message) => this.#setStatus(message)));
    if (this.#ui.busy) this.#ui = { ...this.#ui, status: 'cancelling turn…' };
  }

  async #createRun(parentTaskRunId: TaskRunId | null): Promise<void> {
    const entry = await this.#book.add(parentTaskRunId);
    this.#ui = {
      ...this.#ui,
      selectedIndex: this.#book.runs.indexOf(entry),
      eventScroll: 0,
      status: entry.taskRunId ? `selected ${entry.taskRunId}` : 'room ready',
    };
    this.#redraw();
    await this.#loadEntry(entry);
  }

  async #loadEntry(entry: ScreenEntry): Promise<void> {
    await this.#book.reload?.(entry);
    this.#redraw();
  }

  #frameInput(): FrameInput {
    return {
      ui: this.#ui,
      workspace: this.#book.workspace ?? this.#workspace,
      runs: this.#book.views(),
      model: this.#book.model,
      provider: this.#book.providerId,
      size: this.#terminal.size(),
    };
  }

  #redraw(): void {
    if (this.#stopped || this.#batching) return;
    if (this.#terminal.draw(this.frame())) this.#book.decisionPanel?.presented();
  }

  #setStatus(status: string): void {
    this.#ui = { ...this.#ui, status };
    this.#redraw();
  }

  #track(task: Promise<void>): void {
    this.#pending.track(task, (e) => this.#fail(e));
  }

  #fail(error: unknown): void {
    this.#ui = { ...this.#ui, busy: false, status: `error: ${messageOf(error)}` };
    this.#redraw();
  }
}
