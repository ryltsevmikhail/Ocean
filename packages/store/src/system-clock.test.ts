import { describe, expect, it } from 'vitest';

import { systemClock } from './system-clock.js';

describe('systemClock', () => {
  it('reads the host wall clock on every call', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it('returns a fresh Date so callers cannot poison the shared instance', () => {
    const first = systemClock.now();
    const second = systemClock.now();
    expect(first).not.toBe(second);
  });
});
