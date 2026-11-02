import { BUDGET_DIMENSIONS } from '@runnets/domain';
import type { FrameInput, RunViewData } from './view.js';
import { transcriptLines } from './transcript.js';

export const HELP = [
  'Write a message below and press Enter to send.',
  'PgUp / PgDn or arrows: scroll the dialogue, including while typing.',
  'Tab: focus dialogue / input. Home / End: edit, or jump in focused dialogue.',
  'F2 Tasks: select with arrows or j/k; Enter returns to the dialogue; n creates a task.',
  'F3 Events: committed events and full tool output. F4 Details: status and budgets.',
  'F6 Changeset: capture the task diff and test evidence. Press F6 again to refresh.',
  'F5: show or hide reasoning. F1: this help. Esc: close a panel or cancel a turn.',
  'Ctrl+J or Alt+Enter: new input line. Pasting text never sends it automatically.',
  '/new: independent task. /quit or Ctrl+C twice while idle: exit.',
  'While a task runs you can scroll or prepare your next message. Enter keeps a busy draft.',
];

/** Secondary information fills the body only when its panel is explicitly opened. */
export function details(run: RunViewData | undefined, workspace: string | undefined): string[] {
  if (run === undefined) return ['No task selected.'];
  const state = run.aggregate;
  if (state === null || state.status === 'absent') return [run.taskRunId, 'status: loading'];
  return [
    `workspace: ${workspace ?? '(injected)'}`,
    `id: ${state.id}`,
    `status: ${run.liveMode ?? state.status}`,
    `version: ${state.version}`,
    `model: ${state.model}`,
    `attempts: ${state.attemptCount} (active: ${state.activeAttempt?.attemptId ?? '-'})`,
    `terminal: ${state.terminal?.status ?? '-'}`,
    ...(state.terminal?.failure === null || state.terminal?.failure === undefined
      ? []
      : [`failure: ${state.terminal.failure.message}`]),
    'budget (consumed / limit):',
    ...BUDGET_DIMENSIONS.map(
      (dimension) =>
        `${dimension}: ${state.budget.consumed[dimension]} / ${state.budget.limits[dimension] ?? 'unlimited'}`,
    ),
  ];
}

/** Event diagnostics keep verbose tool output away from the conversation. */
export function eventLines(run: RunViewData | undefined, width: number): string[] {
  if (run === undefined) return ['No task selected.'];
  return [
    ...run.events.map((event) => `#${String(event.sequence).padStart(3, '0')} ${event.type}`),
    ...transcriptLines(
      run.stream.filter((line) => line.kind === 'tool'),
      width,
      false,
      true,
    ),
  ];
}

/** Only visible task rows are materialized; selection remains in view for long sessions. */
export function taskLines(input: FrameInput, height: number): string[] {
  const start = Math.max(0, input.ui.selectedIndex - height + 1);
  return input.runs
    .slice(start, start + height)
    .map(
      (run, offset) =>
        `${start + offset === input.ui.selectedIndex ? '>' : ' '} ${start + offset + 1}. ${run.taskRunId} ${run.liveMode ?? run.aggregate?.status ?? 'loading'}`,
    );
}
