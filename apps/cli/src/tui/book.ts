import { ToolService } from '@runnets/application';
import { RunBook, type RunBookPort } from './runs.js';
import type { TuiAppOptions } from './options.js';
import type { TuiApproval } from './approval.js';

/** Compose the legacy or durable room backend while retaining terminal-owned approvals. */
export function createRunBook(options: TuiAppOptions, approval: TuiApproval): RunBookPort {
  return (
    options.book ??
    new RunBook({
      service: options.service,
      recovered: options.recovered,
      provider: options.provider,
      tools:
        options.executor === undefined
          ? undefined
          : new ToolService(options.executor, approval, options.journal),
    })
  );
}
