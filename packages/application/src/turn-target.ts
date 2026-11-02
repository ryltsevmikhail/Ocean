import { DomainError, isTerminal, type TaskRunId } from '@runnets/domain';
import type { TaskRunService } from './service.js';

/** A new turn can use an unstarted run or an explicit continuation, never unresolved execution. */
export async function selectTurnTask(
  service: TaskRunService,
  current: TaskRunId,
  createContinuation: () => Promise<TaskRunId>,
): Promise<TaskRunId> {
  const state = await service.state(current);
  if (state.status === 'absent') throw DomainError.invalidArgument('task run does not exist');
  if (isTerminal(state.status)) return createContinuation();
  if (['created', 'queued', 'admitted', 'retrying'].includes(state.status)) return current;
  throw DomainError.invalidTransition(
    state.status,
    'start another turn; inspect unresolved execution first',
  );
}
