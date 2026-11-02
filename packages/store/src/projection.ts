/**
 * Read-model projection.
 *
 * The aggregate is never stored: it is rebuilt by replaying the committed
 * stream through the domain `evolve` fold, so the projection and the decision
 * path always observe the same state.
 */

import type { EventLogPort } from '@runnets/application';
import { replay, type TaskRunAggregate, type TaskRunId } from '@runnets/domain';

export async function projectTaskRun(log: EventLogPort, id: TaskRunId): Promise<TaskRunAggregate> {
  return replay(await log.load(id));
}
