import { randomUUID } from 'node:crypto';
import type { ProjectLeasePort } from '@runnets/application';
import { ToolError } from '@runnets/application';
import { SqliteProjectLeases } from './project-leases.js';
/** Uncontained commands reserve the global scope; lexical cwd cannot limit their writes. */
export async function legacyMutation<T>(
  root: string,
  kind: 'legacy-write' | 'legacy-command',
  work: (dispatch: () => void) => Promise<T>,
  leases: ProjectLeasePort = new SqliteProjectLeases(),
): Promise<T> {
  const id = randomUUID();
  const result = leases.acquire(kind === 'legacy-command' ? '*' : root, {
    kind,
    ownerId: 'legacy-' + String(process.pid),
    taskId: id,
    requestId: id,
    binding: id,
  });
  if (!result.ok)
    throw new ToolError('project_busy', 'project mutation is reserved by another operation');
  // Keep a durable hold on thrown or uncertain operations. PID death is not reconciliation.
  let value: T;
  let dispatched = false;
  try {
    value = await work(() => {
      dispatched = true;
    });
  } catch (error) {
    // Preparation failures cannot strand a hold; unknown post-dispatch effects keep theirs.
    if (!dispatched) leases.release(result.value);
    throw error;
  }
  if (!(value && typeof value === 'object' && 'uncertain' in value && value.uncertain === true)) {
    if (!leases.release(result.value))
      throw new ToolError('recovery_required', 'mutation lease could not be released');
  }
  return value;
}
