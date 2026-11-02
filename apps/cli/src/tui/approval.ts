import type {
  CodingApprovalOwnerPort,
  ReviewSnapshot,
  ToolPermissionPort,
} from '@runnets/application';
import type { Key } from './keys.js';
import type { Size } from './types.js';

import { terminalText, wrap } from './text.js';
export { terminalText } from './text.js';

type ApprovalPreview =
  | Parameters<ToolPermissionPort['review']>[0]
  | { readonly title: string; readonly kind: 'review' | 'coding'; readonly preview: string };

type Decision = 'allow_once' | 'allow_session' | 'reject';

/** Exclusive approval screen: no approval keystroke can become a prompt or a run command. */
export class TuiApproval implements ToolPermissionPort {
  #pending: { tool: ApprovalPreview; decide: (decision: Decision) => void } | null = null;
  #offset = 0;
  readonly #redraw: () => void;
  constructor(redraw: () => void) {
    this.#redraw = redraw;
  }

  review(
    tool: Parameters<ToolPermissionPort['review']>[0],
    signal: AbortSignal,
  ): Promise<Decision> {
    return this.#ask(tool, signal);
  }
  codingOwner(
    signal: AbortSignal,
    interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
  ): CodingApprovalOwnerPort {
    return {
      decide: async (approval) => {
        if (!interactive) return 'cancel';
        const decision = await this.#ask(
          {
            kind: 'coding',
            title: 'Approve exact ' + approval.binding.operation,
            preview: JSON.stringify(approval.binding, null, 2) + '\n' + approval.preview,
          },
          signal,
        );
        return decision === 'allow_once' ? 'allow-once' : signal.aborted ? 'cancel' : 'deny';
      },
    };
  }
  /** One owner confirmation cannot become an approval for later operations. */
  async reviewOwner(snapshot: ReviewSnapshot, signal: AbortSignal): Promise<boolean> {
    return (
      (await this.#ask(
        {
          kind: 'review',
          title: 'Continue text-only after ' + snapshot.taskRunId,
          preview:
            'Earlier execution and billing remain unknown. No action is retried or confirmed stopped. New text-only requests may incur new charges.',
        },
        signal,
      )) === 'allow_once'
    );
  }
  #ask(tool: ApprovalPreview, signal: AbortSignal): Promise<Decision> {
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
    else if (
      key.type === 'char' &&
      key.value === 'a' &&
      this.#pending.tool.kind !== 'review' &&
      this.#pending.tool.kind !== 'coding'
    )
      this.#pending.decide('allow_session');
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
      (tool.kind === 'review'
        ? 'Review the unknown outcome before continuing text-only.'
        : tool.kind === 'coding'
          ? 'Review this exact task operation and its limits.'
          : tool.kind === 'execute'
            ? 'Command has your user permissions; cwd is not an OS sandbox.'
            : 'Review file changes before allowing.'
      ).slice(0, width),
      ...lines.slice(this.#offset, this.#offset + height - 3),
      (tool.kind === 'review'
        ? 'y confirm text-only | n deny | arrows scroll'
        : tool.kind === 'coding'
          ? 'y allow once | n deny | arrows scroll'
          : 'y allow once | a allow same operation | n deny | arrows scroll'
      ).slice(0, width),
    ].join('\n');
  }
}
