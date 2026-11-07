import type {
  OperationKey,
  OperationStatus,
  ProjectInput,
  ProjectReplies,
} from '../project-protocol.js';
import type { ProjectRequest } from './project-bridge.js';
import type { WorkMemory } from './project-memory.js';
import { projectAdmission } from './project-state.js';

const unresolved = new Set([
  'allowed',
  'pending',
  'dispatching',
  'applying',
  'requested',
  'unconfirmed',
  'outcome_unknown',
]);

export function unresolvedProjectOperation(
  memory: WorkMemory,
  operations: Partial<Record<OperationKey['operation'], OperationStatus>>,
) {
  return (['prepare', 'review', 'apply'] as const).some((name) => {
    const operation = operations[name];
    if (!memory[name]) return false;
    if (!operation) return true;
    return unresolved.has(
      'state' in operation.result ? operation.result.state : operation.result.status,
    );
  });
}

export async function beginProjectOperation(
  request: ProjectRequest,
  { operation, ...scope }: OperationKey,
  task: ProjectReplies['task'],
  diff: ProjectReplies['diff'] | null,
  review: ProjectReplies['review'] | null,
): Promise<OperationStatus> {
  if (operation === 'prepare')
    return {
      operation,
      result: await request(operation, { ...scope, expectedPolicyVersion: task.policyVersion }),
    };
  if (!diff) throw Error('invalid_request');
  if (operation === 'review')
    return { operation, result: await request(operation, { ...scope, hash: diff.hash }) };
  if (operation !== 'apply' || !review?.verdict) throw Error('invalid_request');
  return {
    operation,
    result: await request(operation, {
      ...scope,
      expectedBase: diff.baseCommit,
      changesetHash: diff.hash,
      reviewRequestId: review.decision.decisionId,
    }),
  };
}

export function projectPreparationAvailable(
  task: ProjectReplies['task'] | null,
  memory: WorkMemory,
  previous: OperationStatus | undefined,
) {
  return (
    task?.status === 'reserved' &&
    !task.worktreeReady &&
    (!memory.prepare ||
      (previous?.operation === 'prepare' &&
        ['denied', 'expired', 'cancelled', 'invalidated', 'interrupted'].includes(
          previous.result.status,
        )))
  );
}

export async function requestProjectCancel(
  request: ProjectRequest,
  input: ProjectInput<'cancel'>,
  refresh: () => Promise<void>,
  restore: () => void,
) {
  let refused = false;
  try {
    await projectAdmission(
      () => request('cancel', input),
      () => {
        refused = true;
      },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    // These responses also precede any cancellation command or controller signal.
    if (
      refused ||
      [
        'version_conflict',
        'run_not_started',
        'run_not_active',
        'terminal_state',
        'invalid_transition',
      ].includes(code)
    ) {
      restore();
      await refresh();
      if (code === 'version_conflict') throw Error('run_version_conflict');
    }
    throw error;
  }
  await refresh();
}
