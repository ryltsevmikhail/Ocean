import { ToolService } from '@runnets/application';
import { RunBook, type RunBookPort } from './runs.js';
import type { TuiAppOptions } from './options.js';
import type { TuiApproval } from './approval.js';

/** Compose the legacy or durable room backend while retaining terminal-owned approvals. */
export function createRunBook(options: TuiAppOptions, approval: TuiApproval): RunBookPort {
  if (options.book !== undefined) {
    options.book.setReviewApproval?.({
      confirm: (snapshot, signal) =>
        (options.input as typeof options.input & { isTTY?: boolean }).isTTY === true
          ? approval.reviewOwner(snapshot, signal)
          : Promise.resolve(false),
    });
    return options.book;
  }
  return new RunBook({
    service: options.service,
    recovered: options.recovered,
    provider: options.provider,
    tools:
      options.executor === undefined
        ? undefined
        : new ToolService(options.executor, approval, options.journal),
  });
}
