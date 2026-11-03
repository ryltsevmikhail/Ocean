import { taskRunId, type ChatTurn } from '@runnets/domain';
import { executeStep } from './commands.js';
import type { TaskRunService } from './service.js';
import { ToolError } from './tools.js';

/** Host admission may use this only before launching any preparation or provider work. */
export class ChatPreparationRefusal extends ToolError {
  constructor(message: string) {
    super('coding_denied', message);
  }
}
/** Call only after joining successful, known-quiescent preparation (or before it starts). */
export async function cancelBeforeDispatch(
  tasks: TaskRunService,
  turn: ChatTurn,
  signal: AbortSignal,
) {
  const id = taskRunId(turn.taskRunId);
  let state = await tasks.state(id);
  if (
    state.status === 'absent' ||
    state.attemptCount !== 0 ||
    (!signal.aborted && state.status !== 'cancelling')
  )
    return false;
  if (state.status !== 'cancelling') {
    const requested = await executeStep(
      tasks,
      id,
      'RequestCancel',
      { cause: 'client cancelled' },
      state.version,
    );
    if (!requested.ok) throw requested.error;
    state = await tasks.state(id);
  }
  const cleaned = await executeStep(
    tasks,
    id,
    'CompleteCleanup',
    { cleanup: 'completed' },
    state.version,
  );
  if (!cleaned.ok) throw cleaned.error;
  return true;
}
