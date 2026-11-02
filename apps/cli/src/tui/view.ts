/** A single scrollable body, a bottom editor and secondary panels on demand. */
import type { TaskRunAggregate, TaskRunId } from '@runnets/domain';
import type { LocalRunSnapshot, LocalRunEvent } from '@runnets/contracts';
import type { UiState } from './state.js';
import type { Size, StreamLine } from './types.js';
import { fit, wrap } from './text.js';
import { transcriptLines, tailPage } from './transcript.js';
import { details, eventLines, HELP, taskLines } from './panels.js';

export interface RunViewData {
  readonly taskRunId: TaskRunId | null;
  readonly remote?: LocalRunSnapshot;
  readonly performer?: { handle: string; provider: string; model: string };
  readonly aggregate: TaskRunAggregate | null;
  readonly events: readonly Pick<LocalRunEvent, 'sequence' | 'type'>[];
  readonly stream: readonly StreamLine[];
  readonly liveMode: string | null;
  readonly codingLines?: readonly string[];
}
export interface FrameInput {
  readonly workspace?: string | undefined;
  readonly ui: UiState;
  readonly runs: readonly RunViewData[];
  readonly model: string;
  readonly provider: string | null;
  readonly size: Size;
}
function dimensions(size: Size): Size {
  const positive = (n: number, fallback: number, minimum: number): number =>
    Number.isFinite(n) && n > 0 ? Math.max(minimum, Math.trunc(n)) : fallback;
  return { columns: positive(size.columns, 100, 20), rows: positive(size.rows, 30, 4) };
}
function draftRows(input: FrameInput, width: number): string[] {
  const { ui } = input;
  const cursor = Math.max(0, Math.min(ui.prompt.length, ui.cursor));
  const marker = ui.focus === 'prompt' ? '▏' : '';
  const marked = ui.prompt.slice(0, cursor) + marker + ui.prompt.slice(cursor);
  const rows = wrap(`> ${marked}`, width);
  const cursorRow = wrap(`> ${ui.prompt.slice(0, cursor)}${marker}`, width).length - 1;
  const start = Math.max(0, cursorRow - 2);
  return rows.slice(start, start + 3);
}
function status(input: FrameInput): string {
  const selected = input.runs[input.ui.selectedIndex];
  if (selected?.remote) {
    const run = selected.remote;
    return `${run.runId} · ${run.taskStatus} · ${run.turnStatus} · v${run.version} · ${input.ui.status ?? ''}`;
  }
  if (selected?.taskRunId === null) return 'Room · ' + (input.ui.status ?? 'ready');
  const state = selected?.aggregate;
  const tokens =
    state === undefined || state === null || state.status === 'absent'
      ? 0
      : state.budget.consumed.provider_tokens;
  return `${selected?.taskRunId ?? 'No task'} · ${selected?.liveMode ?? state?.status ?? 'ready'} · tokens ${tokens} · ${input.ui.status ?? (input.ui.busy ? 'working' : 'ready')}`;
}
function content(
  input: FrameInput,
  width: number,
  height: number,
): { title: string; lines: readonly string[] } {
  const selected = input.runs[input.ui.selectedIndex];
  const focus = input.ui.focus;
  if (focus === 'runs')
    return { title: 'Tasks · Enter select · n new · Esc close', lines: taskLines(input, height) };
  if (focus === 'details')
    return {
      title: 'Details · Esc close',
      lines: details(selected, input.workspace)
        .flatMap((line) => wrap(line, width))
        .slice(input.ui.eventScroll, input.ui.eventScroll + height),
    };
  if (focus === 'changeset')
    return {
      title: 'Changeset · F6 refresh · PgUp/PgDn scroll · Esc close',
      lines: (
        selected?.codingLines ?? ['No coding changeset. Open a task-bound room to inspect changes.']
      )
        .flatMap((line) => wrap(line, width))
        .slice(input.ui.eventScroll, input.ui.eventScroll + height),
    };
  if (focus === 'help')
    return {
      title: 'Help · Esc close',
      lines: HELP.flatMap((line) => wrap(line, width)).slice(
        input.ui.eventScroll,
        input.ui.eventScroll + height,
      ),
    };
  if (focus === 'events')
    return {
      title: 'Events · PgUp/PgDn scroll · Esc close',
      lines: tailPage(eventLines(selected, width), height, input.ui.eventScroll),
    };
  const lines =
    selected === undefined ? [] : transcriptLines(selected.stream, width, input.ui.showThoughts);
  const offset = input.ui.dialogScroll;
  return {
    title: `Dialogue${offset > 0 ? ' · older messages · PgDn returns to latest' : ''}${input.ui.showThoughts ? ' · reasoning visible' : ''}`,
    lines:
      lines.length === 0
        ? ['Write a message below. F1 opens help.']
        : tailPage(lines, height, offset),
  };
}

/** Navigation and rendering use the same wrapped rows, so all output is reachable. */
export function navigationContext(input: FrameInput): {
  dialogCount: number;
  eventCount: number;
  pageSize: number;
} {
  const { columns, rows } = dimensions(input.size);
  const selected = input.runs[input.ui.selectedIndex];
  const eventCount =
    input.ui.focus === 'changeset'
      ? (selected?.codingLines ?? ['No coding changeset.']).flatMap((line) => wrap(line, columns))
          .length
      : input.ui.focus === 'details'
        ? details(selected, input.workspace).flatMap((line) => wrap(line, columns)).length
        : input.ui.focus === 'help'
          ? HELP.flatMap((line) => wrap(line, columns)).length
          : eventLines(selected, columns).length;
  return {
    dialogCount:
      selected === undefined
        ? 0
        : transcriptLines(selected.stream, columns, input.ui.showThoughts).length,
    eventCount,
    pageSize: Math.max(1, rows < 9 ? rows - 3 : rows - 5 - draftRows(input, columns).length),
  };
}

/** New output does not move a reader who has scrolled away from the live bottom. */
export function anchorDialogue(
  ui: UiState,
  previous: readonly StreamLine[],
  next: readonly StreamLine[],
  width: number,
): UiState {
  if (ui.dialogScroll === 0) return ui;
  const oldCount = transcriptLines(previous, width, ui.showThoughts).length;
  const newCount = transcriptLines(next, width, ui.showThoughts).length;
  return {
    ...ui,
    dialogScroll: Math.min(
      Math.max(0, newCount - 1),
      ui.dialogScroll + Math.max(0, newCount - oldCount),
    ),
  };
}

/** Render one full-height frame; normal conversation receives nearly all available rows. */
export function renderFrame(input: FrameInput): string {
  const { columns, rows } = dimensions(input.size);
  const editor = draftRows(input, columns);
  const bot = input.runs[input.ui.selectedIndex]?.performer;
  const header = `RunneTS TUI · ${bot?.provider ?? input.provider ?? 'offline'} / ${bot ? '@' + bot.handle + ' / ' + bot.model : input.model}${input.workspace === undefined ? '' : ` · ${input.workspace}`}`;
  if (rows < 9) {
    const selected = input.runs[input.ui.selectedIndex];
    const latest = selected === undefined ? [] : transcriptLines(selected.stream, columns, false);
    const compact = [
      header,
      ...tailPage(latest, rows - 3, input.ui.dialogScroll),
      editor[0] ?? '> ',
      'F1 help · PgUp/PgDn scroll',
    ];
    while (compact.length < rows) compact.splice(1, 0, '');
    return compact
      .slice(0, rows)
      .map((line) => fit(line, columns))
      .join('\n');
  }
  const height = rows - 5 - editor.length;
  const pane = content(input, columns, height);
  const body = [...pane.lines];
  while (body.length < height) body.push('');
  const footer =
    'Enter send · PgUp/PgDn scroll · F2 tasks · F3 events · F4 details · F5 reasoning · F6 changeset · Esc cancel';
  return [
    header,
    status(input),
    `─ ${pane.title} `,
    ...body.slice(0, height),
    '─'.repeat(columns),
    ...editor,
    footer,
  ]
    .map((line) => fit(line, columns))
    .join('\n');
}
