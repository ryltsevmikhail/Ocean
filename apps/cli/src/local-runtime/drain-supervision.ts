/**
 * One bounded shutdown drain over every host-owned effect.
 *
 * Each participant reports its own settled/uncertain outcome; an unknown effect
 * makes the stop uncertain instead of being silently discarded. Drains that only
 * report completion (or throw) contribute no string outcome and are awaited alike.
 */
import { drainBeforeDeadline } from './drain.js';

type Draining = { drain(): Promise<unknown> } | (() => Promise<unknown>) | undefined;
export async function assertRuntimeDrained(
  parts: readonly Draining[],
  deadlineMs: number,
): Promise<void> {
  const outcome = await drainBeforeDeadline(async () => {
    const outcomes = await Promise.all(
      parts.map((part) =>
        part === undefined ? Promise.resolve() : typeof part === 'function' ? part() : part.drain(),
      ),
    );
    return outcomes.every((result: unknown) => result === undefined || result === 'settled')
      ? 'settled'
      : 'uncertain';
  }, deadlineMs);
  if (outcome !== 'settled') throw Error('stop_incomplete');
}
