/** Pure dialogue navigation, panel toggles and input editing. */
import type { Key, Panel } from './keys.js';
import type { StreamKind, StreamLine } from './types.js';
import { editDraft } from './editor.js';

export type FocusPane = Panel | 'prompt' | 'dialog';
export interface UiState {
  readonly focus: FocusPane;
  readonly selectedIndex: number;
  readonly eventScroll: number;
  readonly dialogScroll: number;
  readonly showThoughts: boolean;
  readonly prompt: string;
  readonly cursor: number;
  readonly status: string | null;
  readonly ctrlCArmed: boolean;
  readonly busy: boolean;
}
export interface UiContext {
  readonly runCount: number;
  readonly remoteActive?: boolean;
  readonly detachOnQuit?: boolean;
  readonly eventCount: number;
  readonly dialogCount?: number;
  readonly pageSize?: number;
}
export type UiAction =
  | { readonly type: 'none' | 'quit' | 'create-run' | 'cancel-turn' }
  | { readonly type: 'send-turn'; readonly prompt: string };
export interface UiTransition {
  readonly state: UiState;
  readonly action: UiAction;
}
export const MAX_PROMPT_LENGTH = 2000;
const MAX_STREAM_LINES = 100;

/** Input is ready immediately; secondary panels occupy no space until requested. */
export function initialUiState(): UiState {
  return {
    focus: 'prompt',
    selectedIndex: 0,
    eventScroll: 0,
    dialogScroll: 0,
    showThoughts: false,
    prompt: '',
    cursor: 0,
    status: null,
    ctrlCArmed: false,
    busy: false,
  };
}
function transition(state: UiState, action: UiAction = { type: 'none' }): UiTransition {
  return { state, action };
}
/** Tab switches only between input and dialogue; panels close back to input. */
export function nextFocus(focus: FocusPane): FocusPane {
  return focus === 'prompt' ? 'dialog' : 'prompt';
}
/** Both Tab directions return to the same two primary focus targets. */
export function previousFocus(focus: FocusPane): FocusPane {
  return nextFocus(focus);
}
function select(state: UiState, index: number, count: number): UiState {
  if (count === 0) return { ...state, status: 'no tasks yet — /new creates one' };
  return {
    ...state,
    selectedIndex: Math.max(0, Math.min(index, count - 1)),
    eventScroll: 0,
    dialogScroll: 0,
  };
}
function scroll(state: UiState, delta: number, context: UiContext): UiState {
  const dialogue = state.focus === 'prompt' || state.focus === 'dialog';
  const field = dialogue ? 'dialogScroll' : 'eventScroll';
  const count = dialogue ? (context.dialogCount ?? context.eventCount) : context.eventCount;
  return {
    ...state,
    [field]: Math.max(
      0,
      Math.min(state[field] + delta, Math.max(0, count - (context.pageSize ?? 1))),
    ),
  };
}

/** Global scrolling never edits a draft, and panel Escape never cancels an active turn. */
export function reduceKey(state: UiState, key: Key, context: UiContext): UiTransition {
  const cleared = { ...state, ctrlCArmed: false };
  if (key.type === 'ctrl-c') {
    if (state.busy || context.remoteActive)
      return transition({ ...cleared, status: 'cancelling turn…' }, { type: 'cancel-turn' });
    return state.ctrlCArmed
      ? transition(cleared, { type: 'quit' })
      : transition({ ...cleared, ctrlCArmed: true, status: 'press Ctrl+C again to quit' });
  }
  if (key.type === 'panel')
    return transition({
      ...cleared,
      focus:
        key.panel === 'changeset' ? 'changeset' : state.focus === key.panel ? 'prompt' : key.panel,
      eventScroll: 0,
    });
  if (key.type === 'toggle-thoughts')
    return transition({ ...cleared, showThoughts: !state.showThoughts, dialogScroll: 0 });
  if (key.type === 'escape') {
    if (state.focus !== 'prompt' && state.focus !== 'dialog')
      return transition({ ...cleared, focus: 'prompt' });
    if (state.busy || context.remoteActive)
      return transition({ ...cleared, status: 'cancelling turn…' }, { type: 'cancel-turn' });
    return transition({ ...cleared, focus: 'prompt' });
  }
  if (key.type === 'tab' || key.type === 'shift-tab')
    return transition({ ...cleared, focus: nextFocus(state.focus) });
  const page = Math.max(1, context.pageSize ?? 10);
  if (state.focus === 'runs') {
    if (key.type === 'enter') return transition({ ...cleared, focus: 'prompt' });
    if (key.type === 'char' && key.value === 'n')
      return state.busy
        ? transition({ ...cleared, status: 'finish or cancel the active turn first' })
        : transition(cleared, { type: 'create-run' });
    if (key.type === 'char' && key.value === 'q') return transition(cleared, { type: 'quit' });
    let delta = 0;
    if (key.type === 'up' || (key.type === 'char' && key.value === 'k')) delta = -1;
    if (key.type === 'down' || (key.type === 'char' && key.value === 'j')) delta = 1;
    if (key.type === 'page-up') delta = -page;
    if (key.type === 'page-down') delta = page;
    if (key.type === 'home') delta = -context.runCount;
    if (key.type === 'end') delta = context.runCount;
    return transition(select(cleared, state.selectedIndex + delta, context.runCount));
  }
  if (
    key.type === 'page-up' ||
    key.type === 'page-down' ||
    key.type === 'up' ||
    key.type === 'down'
  ) {
    let delta =
      key.type === 'page-up' ? page : key.type === 'page-down' ? -page : key.type === 'up' ? 1 : -1;
    if (state.focus === 'details' || state.focus === 'help' || state.focus === 'changeset')
      delta = -delta;
    return transition(scroll(cleared, delta, context));
  }
  if (state.focus !== 'prompt') {
    if (key.type === 'enter') return transition({ ...cleared, focus: 'prompt' });
    if (key.type === 'home')
      return transition(
        state.focus === 'details' || state.focus === 'help' || state.focus === 'changeset'
          ? { ...cleared, eventScroll: 0 }
          : scroll(cleared, Number.MAX_SAFE_INTEGER, context),
      );
    if (key.type === 'end')
      return transition(
        state.focus === 'details' || state.focus === 'help' || state.focus === 'changeset'
          ? scroll(cleared, Number.MAX_SAFE_INTEGER, context)
          : { ...cleared, dialogScroll: 0, eventScroll: 0 },
      );
    if (key.type === 'char' && (key.value === 'j' || key.value === 'k'))
      return transition(
        scroll(
          cleared,
          state.focus === 'changeset' ? (key.value === 'k' ? -1 : 1) : key.value === 'k' ? 1 : -1,
          context,
        ),
      );
    return transition(cleared);
  }
  if (key.type === 'enter') {
    const prompt = state.prompt.trim();
    if (!prompt) return transition({ ...cleared, status: 'prompt is empty' });
    if (prompt === '/quit' && (!state.busy || context.detachOnQuit))
      return transition(cleared, { type: 'quit' });
    if (state.busy)
      return transition({ ...cleared, status: 'a turn is already running; draft kept' });
    const next = { ...cleared, prompt: '', cursor: 0, dialogScroll: 0 };
    return transition(
      next,
      prompt === '/new' ? { type: 'create-run' } : { type: 'send-turn', prompt },
    );
  }
  return transition({ ...cleared, ...editDraft(state, key, MAX_PROMPT_LENGTH) });
}

/** Merge only adjacent chunks of one role; preserve message boundaries and bounded history. */
export function appendStream(
  lines: readonly StreamLine[],
  kind: StreamKind,
  text: string,
): readonly StreamLine[] {
  if (text === '') return lines;
  const last = lines.at(-1);
  const next =
    last !== undefined && last.kind === kind && kind !== 'user'
      ? [...lines.slice(0, -1), { ...last, text: last.text + text }]
      : [...lines, { kind, text }];
  return next.length <= MAX_STREAM_LINES ? next : next.slice(-MAX_STREAM_LINES);
}
