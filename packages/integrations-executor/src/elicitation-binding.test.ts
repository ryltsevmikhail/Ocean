/**
 * Committed negative coverage for `source: "policy"` elicitation authority
 * (Task 4 F4): an unbound policy request must be declined, and only the exact
 * address+canonical-args pair of an in-flight dispatch may be accepted.
 */
import { describe, expect, it } from 'vitest';
import { dispatchBindingKey, elicitationAccepted } from './elicitation-binding.js';

const address = 'github/list_issues';
const args = { owner: 'team', repo: 'api' };
const record = (source?: string): Record<string, unknown> => ({
  request: { _tag: 'FormElicitation' },
  address,
  args,
  ...(source === undefined ? {} : { source }),
});

describe('elicitation authority', () => {
  it('declines an unbound policy request even when a different dispatch is in flight', () => {
    const boundKey = dispatchBindingKey(address, args);
    expect(boundKey).not.toBeNull();
    expect(elicitationAccepted(record('policy'), new Map())).toBe(false);
    expect(elicitationAccepted(record('policy'), new Map([['other-call', 1]]))).toBe(false);
    const otherArgs = dispatchBindingKey(address, { owner: 'team', repo: 'other' });
    expect(elicitationAccepted(record('policy'), new Map([[otherArgs!, 1]]))).toBe(false);
  });

  it('accepts only the exact policy binding and never a tool or absent source', () => {
    const boundKey = dispatchBindingKey(address, args)!;
    const inFlight = new Map([[boundKey, 1]]);
    expect(elicitationAccepted(record('policy'), inFlight)).toBe(true);
    expect(elicitationAccepted(record('tool'), inFlight)).toBe(false);
    expect(elicitationAccepted(record(undefined), inFlight)).toBe(false);
    // A non-string address or unsupported args cannot form a binding at all.
    expect(dispatchBindingKey(undefined, args)).toBeNull();
    expect(elicitationAccepted({ address: 42, args, source: 'policy' }, inFlight)).toBe(false);
  });
});
