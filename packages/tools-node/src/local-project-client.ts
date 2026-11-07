import {
  LOCAL_CODING_WORKSPACE,
  LOCAL_CODING_WORKSPACE_PAGE,
  isCodingProjectsList,
  isCodingProjectsPage,
  isCodingTasksList,
  isCodingTasksPage,
  type CodingProjectsList,
  type CodingProjectsPage,
  type CodingTasksList,
  type CodingTasksPage,
  type LocalRuntimeIdentity,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';

export interface LocalProjectClient {
  listCodingProjects(input: CodingProjectsList): Promise<CodingProjectsPage>;
  listCodingTasks(input: CodingTasksList): Promise<CodingTasksPage>;
}
function matchesPage(
  q: CodingProjectsList,
  v: { workspaceId: string; nextAfter: string | null },
  rows: readonly { id: string }[],
) {
  const limit = q.limit ?? LOCAL_CODING_WORKSPACE_PAGE;
  let after = Buffer.from(q.after ?? '');
  return (
    v.workspaceId === q.workspaceId &&
    rows.length <= limit &&
    (v.nextAfter === null || rows.length === limit) &&
    rows.every((r) => {
      // Match SQLite BINARY ordering, including supplementary characters in task IDs.
      const key = Buffer.from(r.id);
      if (Buffer.compare(key, after) <= 0) return false;
      after = key;
      return true;
    })
  );
}
export function localProjectClient(
  send: (method: string, params: unknown) => Promise<unknown>,
  identity: LocalRuntimeIdentity,
): LocalProjectClient {
  const requireFeature = () => {
    if (!identity.capabilities.includes(LOCAL_CODING_WORKSPACE))
      throw Error('client_upgrade_required');
  };
  return {
    async listCodingProjects(input) {
      requireFeature();
      const q = validatedParams(input, isCodingProjectsList);
      const v = await send('coding.projects.list', q);
      if (!isCodingProjectsPage(v) || !matchesPage(q, v, v.projects)) throw Error('invalid_frame');
      return v;
    },
    async listCodingTasks(input) {
      requireFeature();
      const q = validatedParams(input, isCodingTasksList);
      const v = await send('coding.tasks.list', q);
      if (!isCodingTasksPage(v) || v.projectId !== q.projectId || !matchesPage(q, v, v.tasks))
        throw Error('invalid_frame');
      return v;
    },
  };
}
