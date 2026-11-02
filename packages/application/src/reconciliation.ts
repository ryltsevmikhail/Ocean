import { isTerminal, type TaskRunId } from '@runnets/domain';
import type { TaskRunService } from './service.js';
import type { ToolEffectRecord, ToolJournalPort } from './tools.js';
import { executeStep } from './commands.js';

export interface RecoveryNotice {
  readonly taskRunId: TaskRunId;
  readonly status: string;
  readonly reason: string;
}
export interface RuntimeRecovery {
  readonly tasks: readonly RecoveryNotice[];
  readonly effects: readonly ToolEffectRecord[];
}

/** Run only under exclusive host ownership: lost execution/context never resumes by inference. */
export async function reconcileInterrupted(
  service: TaskRunService,
  tools: ToolJournalPort,
): Promise<RuntimeRecovery> {
  // A committed claim without a settlement is evidence of possible execution, never of no launch.
  for (const effect of await tools.pending()) {
    if (effect.outcome === 'started') await tools.recover(effect.id, effect);
  }
  const tasks: RecoveryNotice[] = [];
  for (const id of await service.listTaskRuns()) {
    let state = await service.state(id);
    if (state.status === 'absent' || isTerminal(state.status)) continue;
    if (state.status !== 'cancelling' && state.status !== 'reconciling') {
      const result = await executeStep(
        service,
        id,
        'BeginReconcile',
        {
          reason: 'reconciliation',
        },
        state.version,
      );
      if (!result.ok) throw result.error;
      state = await service.state(id);
    }
    tasks.push({
      taskRunId: id,
      status: state.status,
      reason:
        'Execution or conversation history was interrupted; inspect effects before starting a new task. Automatic continuation is disabled.',
    });
  }
  return { tasks, effects: await tools.pending() };
}
