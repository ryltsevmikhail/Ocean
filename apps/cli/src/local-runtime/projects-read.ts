import {
  LOCAL_CODING_WORKSPACE_PAGE,
  isCodingProjectsList,
  isCodingProjectSummary,
  isCodingTasksList,
  isCodingTasksPage,
  type CodingWorkspaceReadMethod,
} from '@runnets/contracts';
import type { ProfileReads } from '@runnets/store-sqlite';
import { readCodingProjectSummaries } from '../ocean/coding-projects.js';
import type { RuntimeReply } from './queries.js';

export function projectsRead(
  profile: string,
  reads: ProfileReads,
  method: CodingWorkspaceReadMethod,
  input: Record<string, unknown>,
  draining: boolean,
): RuntimeReply {
  if (draining) return { error: { code: 'runtime_draining' } };
  const q =
    method === 'coding.projects.list'
      ? isCodingProjectsList(input) && input
      : isCodingTasksList(input) && input;
  if (!q) return { error: { code: 'invalid_params' } };
  if (q.workspaceId !== 'ws_ocean') return { error: { code: 'unknown_workspace' } };

  let catalog;
  try {
    catalog = readCodingProjectSummaries(profile);
  } catch {
    return { error: { code: 'project_catalog_unavailable' } };
  }
  if (
    !catalog.every(isCodingProjectSummary) ||
    new Set(catalog.map((p) => p.root)).size !== catalog.length
  )
    return { error: { code: 'project_catalog_unavailable' } };

  const limit = q.limit ?? LOCAL_CODING_WORKSPACE_PAGE;
  const after = q.after ?? '';
  if ('projectId' in q) {
    const project = catalog.find((p) => p.id === q.projectId);
    if (!project) return { error: { code: 'unknown_project' } };
    const rows = reads.codingTasks(q.workspaceId, project.root, after, limit + 1);
    const tasks = rows.slice(0, limit);
    const result = {
      workspaceId: q.workspaceId,
      projectId: project.id,
      tasks,
      nextAfter: rows.length > limit ? tasks.at(-1)!.id : null,
    };
    return isCodingTasksPage(result) ? { result } : { error: { code: 'runtime_failure' } };
  }

  const rows = catalog.filter((p) => p.id > after).sort((a, b) => (a.id < b.id ? -1 : 1));
  const projects = rows.slice(0, limit);
  return {
    result: {
      workspaceId: q.workspaceId,
      projects,
      nextAfter: rows.length > limit ? projects.at(-1)!.id : null,
    },
  };
}
