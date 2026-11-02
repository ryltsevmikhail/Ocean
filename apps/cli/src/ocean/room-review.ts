import { randomUUID } from 'node:crypto';
import type { ReviewApprovalPort, ReviewSnapshot } from '@runnets/application';
import type { Runtime } from '../runtime.js';

/** Terminal-local review navigation retains only the exact evidence the owner has viewed. */
export class RoomReviewController {
  readonly #runtime: Runtime;
  readonly #roomId: string;
  #seen: ReviewSnapshot | null = null;
  #approval: ReviewApprovalPort = { confirm: () => Promise.resolve(false) };
  constructor(runtime: Runtime, roomId: string) {
    this.#runtime = runtime;
    this.#roomId = roomId;
  }
  setApproval(approval: ReviewApprovalPort): void {
    this.#approval = approval;
  }
  /** Slash commands never enter model history or originate another TaskRun. */
  async handle(prompt: string, signal: AbortSignal): Promise<string | null> {
    if (prompt === '/review') {
      const result = await this.#runtime.reviews.reviewRoom('ws_ocean', this.#roomId);
      if (!result.ok) throw new Error(result.error.code);
      this.#seen = result.value;
      return (
        'Interrupted run review\n' +
        JSON.stringify(result.value, null, 2) +
        '\nTo allow future text-only messages: /continue text-only <reason>'
      );
    }
    if (prompt.startsWith('/continue ')) {
      if (this.#seen === null) throw new Error('Use /review before continuing');
      const prefix = '/continue text-only ';
      if (!prompt.startsWith(prefix) || prompt.slice(prefix.length).trim() === '')
        throw new Error('Use /continue text-only <reason>');
      const result = await this.#runtime.reviews.acknowledge(
        {
          workspaceId: 'ws_ocean',
          taskRunId: this.#seen.taskRunId,
          reviewVersion: this.#seen.version,
          reason: prompt.slice(prefix.length),
          requestId: randomUUID(),
        },
        this.#approval,
        signal,
      );
      if (!result.ok) throw new Error(result.error.code);
      this.#seen = null;
      return 'Future text-only messages are allowed. Earlier outcome and billing remain unknown.';
    }
    return null;
  }
}
