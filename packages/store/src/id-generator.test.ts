import { describe, expect, it } from 'vitest';

import { isValidId } from '@runnets/domain';

import { SequentialIdGenerator } from './id-generator.js';

describe('SequentialIdGenerator', () => {
  it('mints event and command ids from independent sequences', () => {
    const ids = new SequentialIdGenerator();

    expect(ids.eventId()).toBe('ev_0001');
    expect(ids.commandId()).toBe('cm_0001');
    expect(ids.eventId()).toBe('ev_0002');
    expect(ids.commandId()).toBe('cm_0002');
  });

  it('produces ids that satisfy the domain id contract', () => {
    const ids = new SequentialIdGenerator('run-a');

    for (let index = 0; index < 5; index += 1) {
      expect(isValidId(ids.eventId(), 'ev')).toBe(true);
      expect(isValidId(ids.commandId(), 'cm')).toBe(true);
    }

    expect(ids.eventId()).toBe('ev_run-a0006');
    expect(ids.commandId()).toBe('cm_run-a0006');
  });

  it('namespaces sequences so separate generators do not collide', () => {
    const first = new SequentialIdGenerator('a');
    const second = new SequentialIdGenerator('b');

    expect(first.eventId()).toBe('ev_a0001');
    expect(second.eventId()).toBe('ev_b0001');
    expect(first.eventId()).not.toBe(second.eventId());
  });

  it('rejects a namespace that would violate the id contract', () => {
    expect(() => new SequentialIdGenerator('Bad_Prefix')).toThrow(RangeError);
    expect(() => new SequentialIdGenerator('-bad')).toThrow(RangeError);
  });
});
