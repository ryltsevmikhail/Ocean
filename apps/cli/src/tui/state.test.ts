import { describe, expect, it } from 'vitest';
import { decodeKeys } from './keys.js';
import {
  appendStream,
  initialUiState,
  nextFocus,
  previousFocus,
  reduceKey,
  type UiContext,
  type UiState,
  type UiTransition,
} from './state.js';
const CONTEXT: UiContext = { runCount: 3, eventCount: 5, dialogCount: 50, pageSize: 10 };
function press(state: UiState, chunk: string, context = CONTEXT): UiTransition {
  let current: UiTransition = { state, action: { type: 'none' } };
  for (const key of decodeKeys(chunk).keys) current = reduceKey(current.state, key, context);
  return current;
}
const tasks = (): UiState => ({ ...initialUiState(), focus: 'runs' });
describe('primary focus and panels', () => {
  it('starts in input and tabs only between input and dialogue', () => {
    expect(initialUiState().focus).toBe('prompt');
    expect(nextFocus('prompt')).toBe('dialog');
    expect(previousFocus('dialog')).toBe('prompt');
    expect(press(initialUiState(), '\t').state.focus).toBe('dialog');
    expect(press(press(initialUiState(), '\t').state, '\x1b[Z').state.focus).toBe('prompt');
  });
  it('opens panels on F keys and closes them without losing drafts or cancelling work', () => {
    const before = { ...initialUiState(), prompt: 'draft', cursor: 5, busy: true };
    for (const sequence of ['\x1bOQ', '\x1bOR', '\x1bOS', '\x1bOP']) {
      const opened = press(before, sequence);
      expect(opened.state.focus).not.toBe('prompt');
      const closed = press(opened.state, '\x1b');
      expect(closed.state.prompt).toBe('draft');
      expect(closed.state.focus).toBe('prompt');
      expect(closed.action.type).toBe('none');
    }
  });
  it('toggles reasoning explicitly', () => {
    const shown = press(initialUiState(), '\x1b[15~');
    expect(shown.state.showThoughts).toBe(true);
    expect(press(shown.state, '\x1b[15~').state.showThoughts).toBe(false);
  });
});
describe('task selection', () => {
  it('selects with arrows and j/k only inside Tasks', () => {
    expect(press(tasks(), 'j').state.selectedIndex).toBe(1);
    expect(press({ ...tasks(), selectedIndex: 2 }, 'j').state.selectedIndex).toBe(2);
    expect(press(tasks(), 'k').state.selectedIndex).toBe(0);
    expect(press(initialUiState(), 'j').state.prompt).toBe('j');
  });
  it('handles an empty task list and resets scroll when selecting', () => {
    expect(press(tasks(), 'j', { runCount: 0, eventCount: 0 }).state.status).toContain('no tasks');
    expect(press({ ...tasks(), eventScroll: 3, dialogScroll: 7 }, 'j').state.dialogScroll).toBe(0);
  });
  it('creates independent tasks only when idle and returns to input on Enter', () => {
    expect(press(tasks(), 'n').action.type).toBe('create-run');
    expect(press({ ...tasks(), busy: true }, 'n').action.type).toBe('none');
    expect(press(tasks(), '\r').state.focus).toBe('prompt');
    expect(press(tasks(), 'q').action.type).toBe('quit');
  });
});
describe('scrolling', () => {
  it('scrolls the dialogue from input without changing its draft', () => {
    const draft = press(initialUiState(), 'draft').state;
    const older = press(draft, '\x1b[5~');
    expect(older.state.dialogScroll).toBe(10);
    expect(older.state.prompt).toBe('draft');
    expect(older.state.focus).toBe('prompt');
    expect(press(older.state, '\x1b[6~').state.dialogScroll).toBe(0);
  });
  it('clamps scroll and jumps to the latest content from dialogue', () => {
    const oldest = press({ ...initialUiState(), focus: 'dialog' }, '\x1b[H');
    expect(oldest.state.dialogScroll).toBe(40);
    expect(press(oldest.state, '\x1b[F').state.dialogScroll).toBe(0);
  });
  it('keeps event scrolling independent from the dialogue', () => {
    const before = { ...initialUiState(), focus: 'events' as const, dialogScroll: 8 };
    const after = press(before, '\x1b[A', { ...CONTEXT, eventCount: 30 });
    expect(after.state.eventScroll).toBe(1);
    expect(after.state.dialogScroll).toBe(8);
  });
});
describe('editing and sending', () => {
  it('edits in the middle with arrows and leaves q as text', () => {
    let state = press(initialUiState(), 'hi q').state;
    state = press(state, '\x1b[D\x7f').state;
    expect(state.prompt).toBe('hiq');
    expect(state.cursor).toBe(2);
    state = press(state, ' ').state;
    expect(state.prompt).toBe('hi q');
  });
  it('deletes a complete emoji or combining grapheme', () => {
    expect(press(press(initialUiState(), 'a👩‍💻').state, '\x7f').state.prompt).toBe('a');
    expect(press(press(initialUiState(), 'é').state, '\x7f').state.prompt).toBe('');
  });
  it('inserts pasted newlines without sending and sends the full prompt on Enter', () => {
    const pasted = press(initialUiState(), '\x1b[200~first\nsecond\x1b[201~');
    expect(pasted.action.type).toBe('none');
    expect(pasted.state.prompt).toBe('first\nsecond');
    const sent = press(pasted.state, '\r');
    expect(sent.action).toEqual({ type: 'send-turn', prompt: 'first\nsecond' });
    expect(sent.state.prompt).toBe('');
    expect(sent.state.cursor).toBe(0);
  });
  it('supports a manual newline and a bounded draft', () => {
    expect(press(initialUiState(), 'a\nb').state.prompt).toBe('a\nb');
    expect(press(initialUiState(), 'a'.repeat(2100)).state.prompt.length).toBe(2000);
  });
  it('preserves busy drafts rather than silently clearing them', () => {
    const state = press({ ...initialUiState(), busy: true }, 'next task').state;
    const sent = press(state, '\r');
    expect(sent.action.type).toBe('none');
    expect(sent.state.prompt).toBe('next task');
  });
  it('does not send empty input and does not drop a draft on Escape', () => {
    expect(press(initialUiState(), '  \r').state.status).toBe('prompt is empty');
    expect(press(press(initialUiState(), 'draft').state, '\x1b').state.prompt).toBe('draft');
  });
  it('accepts explicit /new and /quit commands', () => {
    expect(press(initialUiState(), '/new\r').action.type).toBe('create-run');
    expect(press(initialUiState(), '/quit\r').action.type).toBe('quit');
  });
});
describe('cancel and quit', () => {
  it('arms quitting and disarms it on another key', () => {
    const armed = press(initialUiState(), '\x03');
    expect(armed.state.ctrlCArmed).toBe(true);
    expect(press(armed.state, '\x03').action.type).toBe('quit');
    expect(press(armed.state, 'j').state.ctrlCArmed).toBe(false);
  });
  it('cancels a running turn with Escape or Ctrl+C', () => {
    for (const key of ['\x1b', '\x03'])
      expect(press({ ...initialUiState(), busy: true }, key).action.type).toBe('cancel-turn');
  });
});
describe('stream history', () => {
  it('merges deltas, separates message roles and ignores empty input', () => {
    const rows = appendStream(appendStream([], 'text', 'Hel'), 'text', 'lo');
    expect(rows).toEqual([{ kind: 'text', text: 'Hello' }]);
    expect(appendStream(rows, 'text', '')).toBe(rows);
    expect(appendStream(rows, 'user', 'next').at(-1)).toEqual({ kind: 'user', text: 'next' });
  });
  it('bounds retained entries', () => {
    let rows = [] as ReturnType<typeof appendStream>;
    for (let i = 0; i < 150; i++) rows = appendStream(rows, i % 2 ? 'thought' : 'text', String(i));
    expect(rows).toHaveLength(100);
    expect(rows.at(-1)?.text).toBe('149');
  });
});
