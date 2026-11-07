import { codingFailure, ok, type CodingResult, type CodingTask } from '@runnets/domain';
import type { StartCodingTask } from './coding-ports.js';
import type { CodingServiceDeps } from './coding-service.js';
import { codingBinding, validCodingStart } from './coding-validation.js';

/** Read an exact start receipt without executing or inferring an effect. */
export function reservationReceipt(
  deps: CodingServiceDeps,
  input: StartCodingTask,
): CodingResult<CodingTask | null> {
  if (!validCodingStart(input)) return codingFailure('invalid_input');
  return deps.store.atomic((tx) => {
    const receipt = tx.receipt(input.requestId);
    if (!receipt) return ok(null);
    if (receipt.binding !== codingBinding(input)) return codingFailure('request_conflict');
    const task = tx.task(receipt.taskId);
    if (!task) return codingFailure('recovery_required');
    if (task.lease.ownerId !== deps.ownerId) return codingFailure('coding_denied');
    return ok(task);
  });
}
