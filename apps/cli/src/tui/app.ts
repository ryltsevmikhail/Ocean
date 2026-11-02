/** Terminal input and rendering; RunBook composes the runtime and turn engine. */

import type { Readable, Writable } from 'node:stream';

import type { SessionUpdate } from '@runnets/contracts';
import type { TaskRunId } from '@runnets/domain';

import { createRunBook } from './book.js';
import { TuiApproval } from './approval.js';
import type { Key } from './keys.js';
import { KeyInput } from './input.js';
import { applyUpdate, runView, turnStatus, type RunEntry, type RunBookPort } from './runs.js';
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

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unexpected error';
}

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
  #pending = new Set<Promise<void>>();
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
    this.#endHandler = (): void => {
      this.#quit();
    };
    this.#resizeHandler = (): void => {
      this.#redraw();
    };
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
  }

  /** Restore the terminal and detach listeners; safe to call more than once. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelTurn();
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
    return this.#approval.frame(this.#terminal.size()) ?? renderFrame(this.#frameInput());
  }

  selectedRun(): RunViewData | null {
    const entry = this.#book.runs[this.#ui.selectedIndex];
    return entry === undefined ? null : runView(entry);
  }

  /** Await every pending runtime action, including cancellation settlement. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) {
      const batch = Array.from(this.#pending);
      this.#pending.clear();
      await Promise.allSettled(batch);
    }
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
    const transition = reduceKey(this.#ui, key, {
      runCount: this.#book.runs.length,
      ...navigationContext(this.#frameInput()),
    });
    this.#ui = transition.state;
    switch (transition.action.type) {
      case 'quit':
        this.#quit();
        return;
      case 'cancel-turn':
        this.#cancelTurn();
        break;
      case 'create-run':
        this.#newRun();
        break;
      case 'send-turn':
        this.#sendTurn(transition.action.prompt);
        break;
      case 'none':
        break;
    }
    this.#redraw();
  }

  #newRun(): void {
    this.#track(this.#createRun(null));
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
    this.#ui = { ...this.#ui, busy: true, status: `turn started on ${entry.taskRunId}` };
    this.#track(this.#performTurn(entry, prompt));
  }

  async #performTurn(entry: RunEntry, prompt: string): Promise<void> {
    let target = entry;
    await this.#loadEntry(target);
    const opened = await this.#book.openForTurn(target);
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

  #onUpdate(entry: RunEntry, update: SessionUpdate): void {
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
    this.#book.cancel();
    if (this.#ui.busy) this.#ui = { ...this.#ui, status: 'cancelling turn…' };
  }

  async #createRun(parentTaskRunId: TaskRunId | null): Promise<void> {
    const entry = await this.#book.add(parentTaskRunId);
    this.#ui = {
      ...this.#ui,
      selectedIndex: this.#book.runs.length - 1,
      eventScroll: 0,
      status: `created ${entry.taskRunId}`,
    };
    this.#redraw();
    await this.#loadEntry(entry);
  }

  async #loadEntry(entry: RunEntry): Promise<void> {
    await this.#book.reload(entry);
    this.#redraw();
  }

  #frameInput(): FrameInput {
    return {
      ui: this.#ui,
      workspace: this.#workspace,
      runs: this.#book.views(),
      model: this.#book.model,
      provider: this.#book.providerId,
      size: this.#terminal.size(),
    };
  }

  #redraw(): void {
    if (this.#stopped || this.#batching) return;
    this.#terminal.draw(this.frame());
  }

  #setStatus(status: string): void {
    this.#ui = { ...this.#ui, status };
    this.#redraw();
  }

  #quit(): void {
    this.stop();
    this.#resolveExit();
  }

  #track(task: Promise<void>): void {
    const guarded = task.catch((error: unknown) => {
      this.#fail(error);
    });
    this.#pending.add(guarded);
    const cleanup = (): void => {
      this.#pending.delete(guarded);
    };
    void guarded.then(cleanup, cleanup);
  }

  #fail(error: unknown): void {
    this.#ui = { ...this.#ui, busy: false, status: `error: ${messageOf(error)}` };
    this.#redraw();
  }
}
