/**
 * Wall-clock adapter.
 *
 * Production wiring uses this clock. Tests should inject a fixed fake instead
 * so committed timestamps and due dates stay deterministic. The adapter is
 * stateless and reads the host clock on every call.
 */

import type { Clock } from '@runnets/application';

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
