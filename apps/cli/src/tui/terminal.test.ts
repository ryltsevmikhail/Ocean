/**
 * Terminal control tests: escape sequences are asserted on injected streams,
 * including the redirected-stream path that must not emit any.
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { Terminal } from './terminal.js';

const SIZE = { columns: 100, rows: 30 };

interface FakeInput extends PassThrough {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

interface FakeOutput extends PassThrough {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

function readAll(stream: PassThrough): string {
  let text = '';
  for (;;) {
    const chunk: unknown = stream.read();
    if (chunk === null || chunk === undefined) break;
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return text;
}

function rawInput(calls: boolean[]): FakeInput {
  const input: FakeInput = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (mode: boolean): void => {
    calls.push(mode);
  };
  return input;
}

function ttyOutput(columns = SIZE.columns, rows = SIZE.rows): FakeOutput {
  const output: FakeOutput = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  return output;
}

describe('Terminal', () => {
  it('writes no control sequences on redirected streams', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const terminal = new Terminal({ input, output, fallbackSize: SIZE });

    terminal.enter();
    terminal.draw('frame');
    terminal.leave();

    const text = readAll(output);
    expect(text).not.toContain('\u001b[');
    expect(text).toBe('frame\n');
    expect(terminal.interactive).toBe(false);
  });

  it('enters the alternate screen, hides the cursor and enables raw mode', () => {
    const calls: boolean[] = [];
    const input = rawInput(calls);
    const output = ttyOutput();
    const terminal = new Terminal({ input, output, fallbackSize: SIZE });

    terminal.enter();
    terminal.draw('frame');

    const text = readAll(output);
    expect(text.startsWith('\u001b[?1049h\u001b[?25l')).toBe(true);
    expect(text).toContain('\u001b[H\u001b[2Jframe');
    expect(calls).toEqual([true]);
    expect(terminal.interactive).toBe(true);
  });

  it('restores the cursor, the main screen and cooked mode on leave', () => {
    const calls: boolean[] = [];
    const input = rawInput(calls);
    const output = ttyOutput();
    const terminal = new Terminal({ input, output, fallbackSize: SIZE });

    terminal.enter();
    readAll(output);
    terminal.leave();

    expect(readAll(output)).toBe('\u001b[?2004l\u001b[?1007l\u001b[?7h\u001b[?25h\u001b[?1049l');
    expect(calls).toEqual([true, false]);
  });

  it('is idempotent for enter and leave', () => {
    const calls: boolean[] = [];
    const input = rawInput(calls);
    const output = ttyOutput();
    const terminal = new Terminal({ input, output, fallbackSize: SIZE });

    terminal.enter();
    terminal.enter();
    readAll(output);
    terminal.leave();
    terminal.leave();

    expect(readAll(output)).toBe('\u001b[?2004l\u001b[?1007l\u001b[?7h\u001b[?25h\u001b[?1049l');
    expect(calls).toEqual([true, false]);
  });

  it('reports the output size and falls back when it is missing', () => {
    const input = new PassThrough();
    const sized = ttyOutput(132, 44);
    expect(new Terminal({ input, output: sized, fallbackSize: SIZE }).size()).toEqual({
      columns: 132,
      rows: 44,
    });

    const plain = new PassThrough();
    expect(new Terminal({ input, output: plain, fallbackSize: SIZE }).size()).toEqual(SIZE);
  });

  it('enables raw mode without the alternate screen when output is redirected', () => {
    const calls: boolean[] = [];
    const input = rawInput(calls);
    const output = new PassThrough();
    const terminal = new Terminal({ input, output, fallbackSize: SIZE });

    terminal.enter();
    terminal.draw('frame');
    terminal.leave();

    expect(readAll(output)).toBe('frame\n');
    expect(calls).toEqual([true, false]);
  });
});

it('updates only changed rows and does not repaint an identical screen', () => {
  const output = ttyOutput();
  const terminal = new Terminal({ input: new PassThrough(), output, fallbackSize: SIZE });
  terminal.enter();
  terminal.draw('first row\nsecond row');
  readAll(output);
  terminal.draw('first row\nchanged row');
  const patch = readAll(output);
  expect(patch).toContain('\x1b[2;1H');
  expect(patch).toContain('changed row');
  expect(patch).not.toContain('first row');
  expect(patch).not.toContain('\x1b[2J');
  terminal.draw('first row\nchanged row');
  expect(readAll(output)).toBe('');
  terminal.leave();
});
