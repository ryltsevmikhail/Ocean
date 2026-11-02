/**
 * Key decoding tests: raw input chunks map to named keys deterministically.
 */

import { describe, expect, it } from 'vitest';

import { decodeKeys } from './keys.js';

function keys(chunk: string) {
  return decodeKeys(chunk).keys;
}

describe('decodeKeys', () => {
  it('decodes printable characters in order', () => {
    expect(keys('hi')).toEqual([
      { type: 'char', value: 'h' },
      { type: 'char', value: 'i' },
    ]);
  });

  it('decodes arrows, tab, shift-tab, enter and backspace', () => {
    expect(keys('\u001b[A')).toEqual([{ type: 'up' }]);
    expect(keys('\u001b[B')).toEqual([{ type: 'down' }]);
    expect(keys('\u001b[C')).toEqual([{ type: 'right' }]);
    expect(keys('\u001b[D')).toEqual([{ type: 'left' }]);
    expect(keys('\u001b[Z')).toEqual([{ type: 'shift-tab' }]);
    expect(keys('\t')).toEqual([{ type: 'tab' }]);
    expect(keys('\r')).toEqual([{ type: 'enter' }]);
    expect(keys('\n')).toEqual([{ type: 'newline' }]);
    expect(keys('\u007f')).toEqual([{ type: 'backspace' }]);
    expect(keys('\b')).toEqual([{ type: 'backspace' }]);
  });

  it('treats a lone escape as the Escape key', () => {
    expect(keys('\u001b')).toEqual([{ type: 'escape' }]);
    expect(keys('a\u001b')).toEqual([{ type: 'char', value: 'a' }, { type: 'escape' }]);
  });

  it('decodes Ctrl+C and ignores unsupported control characters', () => {
    expect(keys('\u0003')).toEqual([{ type: 'ctrl-c' }]);
    expect(keys('\u0001')).toEqual([{ type: 'home' }]);
    expect(keys('\u0002')).toEqual([{ type: 'unknown' }]);
  });

  it('buffers an unterminated CSI sequence until the next chunk', () => {
    const first = decodeKeys('\u001b[');
    expect(first.keys).toEqual([]);
    expect(first.rest).toBe('\u001b[');

    const second = decodeKeys(`${first.rest}A`);
    expect(second.keys).toEqual([{ type: 'up' }]);
    expect(second.rest).toBe('');
  });

  it('decodes a mixed chunk in input order', () => {
    expect(keys('j\u001b[Bq')).toEqual([
      { type: 'char', value: 'j' },
      { type: 'down' },
      { type: 'char', value: 'q' },
    ]);
  });

  it('reports unsupported escape sequences as unknown keys', () => {
    expect(keys('\u001b[1;5A')).toEqual([{ type: 'unknown' }]);
  });
});
