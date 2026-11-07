import { expect, it } from 'vitest';
import { admitRoomCount } from './room-task-authority.js';
it.each([
  ['child_runs', 31, 32],
  ['tool_calls', 63, 64],
] as const)(
  'admits only the last available %s reservation without refunding prior durable charges',
  (dimension, last, full) => {
    const counts = {
      active: 0,
      slices: dimension === 'child_runs' ? last : 0,
      modelStarts: 0,
      toolCalls: dimension === 'tool_calls' ? last : 0,
    };
    expect(admitRoomCount(counts, dimension)).toBe(true);
    const spent = {
      ...counts,
      ...(dimension === 'child_runs' ? { slices: full } : { toolCalls: full }),
    };
    expect(admitRoomCount(spent, dimension)).toBe(false);
    expect(admitRoomCount(spent, dimension)).toBe(false);
    expect(counts).toEqual({
      active: 0,
      slices: dimension === 'child_runs' ? last : 0,
      modelStarts: 0,
      toolCalls: dimension === 'tool_calls' ? last : 0,
    });
  },
);
