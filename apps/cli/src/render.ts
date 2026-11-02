/**
 * Human and JSON rendering for the CLI.
 *
 * Output is a pure function of the event stream and the projected state, so
 * the same run renders identically in tests and in a terminal.
 */

import type { CommandReceipt } from '@runnets/application';
import type { TaskRunAggregate } from '@runnets/domain';

export function renderEvents(receipts: readonly CommandReceipt[]): string {
  const lines: string[] = [];
  for (const receipt of receipts) {
    for (const event of receipt.events) {
      lines.push(
        `#${String(event.sequence).padStart(2, '0')} ${event.type.padEnd(28)} ${event.eventId}`,
      );
    }
  }
  return lines.join('\n');
}

export function renderState(state: TaskRunAggregate): string {
  if (state.status === 'absent') return 'task run: absent (no committed events)';
  const attempts = state.activeAttempt?.attemptId ?? '-';
  return [
    `task run:   ${state.id}`,
    `status:     ${state.status}`,
    `version:    ${state.version}`,
    `model:      ${state.model}`,
    `attempts:   ${state.attemptCount} (active: ${attempts})`,
    `checkpoint: ${state.lastCommittedCheckpointId ?? '-'}`,
    `terminal:   ${state.terminal?.status ?? '-'}`,
  ].join('\n');
}

export function renderJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
