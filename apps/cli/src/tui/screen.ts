import type { TaskRunId } from '@runnets/domain';
import type { RunBookPort } from './runs.js';
import type { TuiApproval } from './approval.js';
import type { Terminal } from './terminal.js';
import { presentFrame, type FrameInput, type PresentedFrame } from './view.js';

/** Keep only the binding that the terminal accepted in a visible status row. */
export class TuiScreen {
  #displayed: PresentedFrame['cancel'];
  readonly #terminal: Terminal;
  readonly #book: RunBookPort;
  readonly #approval: TuiApproval;
  constructor(terminal: Terminal, book: RunBookPort, approval: TuiApproval) {
    this.#terminal = terminal;
    this.#book = book;
    this.#approval = approval;
  }
  present(input: FrameInput): PresentedFrame {
    const size = this.#terminal.decisionSize;
    const modal = this.#book.decisionPanel?.frame(size) ?? this.#approval.frame(input.size);
    return modal === null ? presentFrame(input, size) : { text: modal };
  }
  draw(input: FrameInput) {
    const frame = this.present(input);
    const drawn = this.#terminal.draw(frame.text);
    this.#displayed = drawn ? frame.cancel : undefined;
    if (drawn) this.#book.decisionPanel?.presented();
  }
  cancelTarget(selected: TaskRunId | null | undefined) {
    const displayed = this.#displayed,
      size = this.#terminal.decisionSize;
    if (
      !displayed ||
      displayed.run.runId !== selected ||
      size.columns !== displayed.size.columns ||
      size.rows !== displayed.size.rows
    )
      return undefined;
    return displayed.run;
  }
}
