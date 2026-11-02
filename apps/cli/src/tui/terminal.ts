/**
 * Terminal control: alternate screen, cursor visibility and raw mode.
 *
 * Every capability is optional. With redirected streams (`isTTY` unset) the
 * terminal performs no escape-sequence writes and still accepts frames, so the
 * TUI runs in a pipe or a test without a real terminal. `enter`/`leave` are
 * idempotent, and the host always calls `leave` from a `finally` block.
 */

import type { Readable, Writable } from 'node:stream';

import type { Size } from './types.js';

const ENTER_ALT_SCREEN = '\u001b[?1049h';
const LEAVE_ALT_SCREEN = '\u001b[?1049l';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR_AND_HOME = '\u001b[H\u001b[2J';

interface TtyInput extends Readable {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

interface TtyOutput extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export interface TerminalOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** Size used when the output stream does not report dimensions. */
  readonly fallbackSize: Size;
}

function dimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

export class Terminal {
  readonly #input: TtyInput;
  readonly #output: TtyOutput;
  readonly #fallback: Size;
  #raw = false;
  #alternate = false;
  #lastFrame: readonly string[] | null = null;
  #lastSize = '';
  #blocked = false;
  #pending: string | null = null;
  readonly #drain = (): void => {
    this.#blocked = false;
    const frame = this.#pending;
    this.#pending = null;
    if (frame !== null) this.draw(frame);
  };

  constructor(options: TerminalOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#fallback = options.fallbackSize;
  }

  /** True when frames should own the screen (output is a terminal). */
  get interactive(): boolean {
    return this.#output.isTTY === true;
  }

  /** Enter raw mode and the alternate screen; safe to call twice. */
  enter(): void {
    if (!this.#raw && this.#input.isTTY === true && typeof this.#input.setRawMode === 'function') {
      this.#input.setRawMode(true);
      this.#raw = true;
    }
    if (!this.#alternate && this.interactive) {
      this.#write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}\u001b[?7l\u001b[?2004h\u001b[?1007h`);
      this.#alternate = true;
    }
  }

  /** Restore the cursor, the main screen and cooked terminal mode. */
  leave(): void {
    this.#output.off('drain', this.#drain);
    this.#pending = null;
    this.#lastFrame = null;
    this.#blocked = false;
    if (this.#alternate) {
      this.#write(`\u001b[?2004l\u001b[?1007l\u001b[?7h${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
      this.#alternate = false;
    }
    if (this.#raw) {
      this.#input.setRawMode?.(false);
      this.#raw = false;
    }
  }

  /** Paint changed rows only; under backpressure retain only the latest pending frame. */
  draw(frame: string): void {
    if (frame === '') return;
    if (this.#blocked) {
      this.#pending = frame;
      return;
    }
    const lines = frame.split('\n');
    const size = this.size();
    const stamp = `${size.columns}:${size.rows}`;
    let output = '';
    if (!this.interactive) {
      if (this.#lastFrame?.join('\n') !== frame) output = `${frame}\n`;
    } else if (this.#lastFrame === null || stamp !== this.#lastSize)
      output = `${CLEAR_AND_HOME}${frame}`;
    else {
      for (let row = 0; row < Math.max(lines.length, this.#lastFrame.length); row++) {
        if (lines[row] !== this.#lastFrame[row])
          output += `\u001b[${row + 1};1H\u001b[2K${lines[row] ?? ''}`;
      }
    }
    this.#lastFrame = lines;
    this.#lastSize = stamp;
    if (output !== '' && !this.#output.write(output)) {
      this.#blocked = true;
      this.#output.once('drain', this.#drain);
    }
  }

  /** Current output dimensions, falling back to the injected size. */
  size(): Size {
    return {
      columns: dimension(this.#output.columns, this.#fallback.columns),
      rows: dimension(this.#output.rows, this.#fallback.rows),
    };
  }

  #write(text: string): void {
    this.#output.write(text);
  }
}
