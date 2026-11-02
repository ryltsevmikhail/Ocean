import { expect, it, vi } from 'vitest';
import { KeyInput, KeyReader } from './input.js';
import { decodeKeys } from './keys.js';
import { initialUiState, reduceKey } from './state.js';
import { displayWidth, fit, wrap } from './text.js';

it('preserves UTF-8 when a Cyrillic character is split between reads', () => {
  const reader = new KeyReader();
  const bytes = Buffer.from('Привет 👩‍💻');
  const keys = [
    ...reader.read(bytes.subarray(0, 1)),
    ...reader.read(bytes.subarray(1, 5)),
    ...reader.read(bytes.subarray(5)),
  ];
  expect(
    keys
      .filter((key) => key.type === 'char')
      .map((key) => key.value)
      .join(''),
  ).toBe('Привет 👩‍💻');
});
it('buffers split paste markers and never treats pasted newlines as Enter', () => {
  const reader = new KeyReader();
  expect(reader.read('\x1b[200~first\nsec')).toEqual([]);
  expect(reader.read('ond\x1b[20')).toEqual([]);
  expect(reader.read('1~')).toEqual([{ type: 'paste', text: 'first\nsecond' }]);
});
it('bounds oversized paste buffering without losing the closing marker', () => {
  const reader = new KeyReader();
  expect(reader.read('\x1b[200~' + 'a'.repeat(100000) + '\x1b[20')).toEqual([]);
  const result = reader.read('1~');
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ type: 'paste', text: 'a'.repeat(2000) });
});
it('paste containing control keys cannot open a panel, quit or submit a task', () => {
  const reader = new KeyReader();
  let state = initialUiState();
  for (const key of reader.read('\x1b[200~q\n/new\r\x1bOQ\x1b[201~')) {
    const result = reduceKey(state, key, { runCount: 1, eventCount: 0 });
    expect(result.action.type).toBe('none');
    state = result.state;
  }
  expect(state.focus).toBe('prompt');
  expect(state.prompt).toContain('/new');
});
it('supports both common F-key encodings and page scrolling', () => {
  expect(decodeKeys('\x1bOQ').keys).toEqual([{ type: 'panel', panel: 'runs' }]);
  expect(decodeKeys('\x1b[12~').keys).toEqual([{ type: 'panel', panel: 'runs' }]);
  expect(decodeKeys('\x1b[6~').keys).toEqual([{ type: 'page-down' }]);
});
it('wraps and pads terminal cells without splitting graphemes', () => {
  expect(displayWidth('a界👩‍💻')).toBe(5);
  expect(wrap('a界👩‍💻', 3)).toEqual(['a界', '👩‍💻']);
  expect(displayWidth(fit('a界👩‍💻', 4))).toBe(4);
  expect(fit('é', 2)).toBe('é ');
  expect(wrap('\x1b[2Janswer', 80).join('')).not.toContain('\x1b');
});

it('buffers every split of the opening paste marker without cancellation or submission', () => {
  const text = '\x1b[200~fix\r/new\x1b[201~';
  for (let split = 1; split < 6; split++) {
    const reader = new KeyReader();
    expect(reader.read(text.slice(0, split))).toEqual([]);
    expect(reader.read(text.slice(split))).toEqual([{ type: 'paste', text: 'fix\r/new' }]);
  }
});

it('defers isolated Escape, cancels it for paste, and clears pending keys on close', () => {
  vi.useFakeTimers();
  try {
    const deliver = vi.fn();
    const input = new KeyInput(deliver);
    input.read('\x1b');
    expect(deliver).not.toHaveBeenCalledWith([{ type: 'escape' }]);
    input.read('[200~hello\rworld\x1b[201~');
    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenLastCalledWith([{ type: 'paste', text: 'hello\rworld' }]);
    expect(deliver).not.toHaveBeenCalledWith([{ type: 'escape' }]);
    input.read('\x1b');
    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenLastCalledWith([{ type: 'escape' }]);
    input.read('\x1b');
    const calls = deliver.mock.calls.length;
    input.close();
    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});
