import type { ToolPermissionPort } from '@runnets/application';
import type { Key } from './keys.js';
import type { Size } from './types.js';

import { terminalText, wrap } from './text.js';
export { terminalText } from './text.js';

type ApprovalPreview = Parameters<ToolPermissionPort['review']>[0];

type Decision = 'allow_once' | 'allow_session' | 'reject';

/** Exclusive approval screen: no approval keystroke can become a prompt or a run command. */
export class TuiApproval implements ToolPermissionPort {
  #pending: { tool: ApprovalPreview; decide: (decision: Decision) => void } | null = null;
  #offset = 0;
  readonly #redraw: () => void;
  constructor(redraw: () => void) {
    this.#redraw = redraw;
  }

  review(tool: ApprovalPreview, signal: AbortSignal): Promise<Decision> {
    if (signal.aborted || this.#pending !== null) return Promise.resolve('reject');
    return new Promise((resolve) => {
      const abort = (): void => decide('reject');
      const decide = (decision: Decision): void => {
        signal.removeEventListener('abort', abort);
        this.#pending = null;
        resolve(decision);
        this.#redraw();
      };
      this.#offset = 0;
      this.#pending = { tool, decide };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else this.#redraw();
    });
  }

  handle(key: Key): boolean {
    if (this.#pending === null) return false;
    if (key.type === 'ctrl-c' || key.type === 'escape') {
      this.#pending.decide('reject');
      return false;
    }
    if (key.type === 'char' && key.value === 'y') this.#pending.decide('allow_once');
    else if (key.type === 'char' && key.value === 'a') this.#pending.decide('allow_session');
    else if (key.type === 'char' && key.value === 'n') this.#pending.decide('reject');
    else if (key.type === 'up') this.#offset = Math.max(0, this.#offset - 1);
    else if (key.type === 'down') this.#offset += 1;
    else if (key.type === 'page-up') this.#offset = Math.max(0, this.#offset - 20);
    else if (key.type === 'page-down') this.#offset += 20;
    else if (key.type === 'home') this.#offset = 0;
    else if (key.type === 'end') this.#offset = Number.MAX_SAFE_INTEGER;
    this.#redraw();
    return true;
  }

  frame(size: Size): string | null {
    if (this.#pending === null) return null;
    const width = Math.max(20, size.columns);
    const height = Math.max(4, size.rows);
    const tool = this.#pending.tool;
    const lines = wrap(tool.preview, width);
    this.#offset = Math.min(this.#offset, Math.max(0, lines.length - height + 4));
    return [
      `Permission: ${terminalText(tool.title)}`.slice(0, width),
      (tool.kind === 'execute'
        ? 'Command has your user permissions; cwd is not an OS sandbox.'
        : 'Review file changes before allowing.'
      ).slice(0, width),
      ...lines.slice(this.#offset, this.#offset + height - 3),
      'y allow once | a allow same operation | n deny | arrows scroll'.slice(0, width),
    ].join('\n');
  }
}
