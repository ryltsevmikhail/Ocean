import { expect, it } from 'vitest';
import { roomAddress } from './room-address.js';
it('recognizes only one leading user mention and leaves quoted or embedded mentions as content', () => {
  expect(roomAddress('@dev hello', undefined)).toEqual({ ok: true, value: 'dev' });
  expect(roomAddress('hello @dev', undefined)).toEqual({ ok: true, value: null });
  expect(roomAddress('> @dev quote', undefined)).toEqual({ ok: true, value: null });
  expect(roomAddress('hello', 'review')).toEqual({ ok: true, value: 'review' });
  expect(roomAddress('@dev hello', 'dev')).toEqual({ ok: true, value: 'dev' });
  for (const [text, to] of [
    ['@dev @review both', undefined],
    ['@dev hi', 'review'],
    ['@INVALID bad', undefined],
  ]) {
    expect(roomAddress(text ?? '', to)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  }
});
