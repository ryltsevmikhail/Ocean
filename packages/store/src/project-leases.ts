import {
  ok,
  codingFailure,
  projectRootsOverlap,
  type ProjectLease,
  type ProjectLeaseHolder,
  type CodingResult,
} from '@runnets/domain';
import type { ProjectLeasePort } from '@runnets/application';
/** Share one instance across profiles to model the per-user durable registry. */
export class InMemoryProjectLeases implements ProjectLeasePort {
  #entries = new Map<string, ProjectLease>();
  #sequence = 0;
  acquire(projectRoot: string, holder: ProjectLeaseHolder): CodingResult<ProjectLease> {
    for (const lease of this.#entries.values()) {
      if (
        JSON.stringify([
          lease.projectRoot,
          lease.ownerId,
          lease.taskId,
          lease.requestId,
          lease.binding,
          lease.kind,
        ]) ===
        JSON.stringify([
          projectRoot,
          holder.ownerId,
          holder.taskId,
          holder.requestId,
          holder.binding,
          holder.kind,
        ])
      )
        return ok(structuredClone(lease));
      if (projectRootsOverlap(projectRoot, lease.projectRoot)) return codingFailure('project_busy');
    }
    const lease = { ...holder, projectRoot, token: 'lease-' + String(++this.#sequence) };
    this.#entries.set(lease.token, structuredClone(lease));
    return ok(lease);
  }
  owns(lease: ProjectLease): boolean {
    return JSON.stringify(this.#entries.get(lease.token)) === JSON.stringify(lease);
  }
  release(lease: ProjectLease): boolean {
    if (!this.#entries.has(lease.token)) return true;
    if (!this.owns(lease)) return false;
    return this.#entries.delete(lease.token);
  }
}
