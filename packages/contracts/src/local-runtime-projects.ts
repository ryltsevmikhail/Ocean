import { validConversationText, type CodingTask } from '@runnets/domain';
import { localRuntimeRecord } from './local-runtime.js';
import { localPosition, type LocalRoomsQuery } from './local-runtime-queries.js';

export const LOCAL_CODING_WORKSPACE = 'coding.workspace-v1';
export const LOCAL_CODING_WORKSPACE_PAGE = 50;
export type CodingWorkspaceReadMethod = 'coding.projects.list' | 'coding.tasks.list';
export const isCodingWorkspaceRead = (method: string): method is CodingWorkspaceReadMethod =>
  method === 'coding.projects.list' || method === 'coding.tasks.list';

export type CodingProjectsList = LocalRoomsQuery;
export type CodingTasksList = CodingProjectsList & { readonly projectId: string };
export interface CodingProjectSummary {
  readonly id: string;
  readonly root: string;
  readonly presetIds: readonly string[];
}
export interface CodingTaskSummary {
  readonly id: string;
  readonly status: CodingTask['status'];
  readonly ownerRoomId: string;
  readonly devBotId: string;
  readonly reviewRoomId: string;
  readonly reviewBotId: string;
  /** Durable preparation state, not evidence of a live lease or authority to execute. */
  readonly worktreeReady: boolean;
}
export interface CodingProjectsPage {
  readonly workspaceId: string;
  readonly projects: readonly CodingProjectSummary[];
  readonly nextAfter: string | null;
}
export interface CodingTasksPage {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly tasks: readonly CodingTaskSummary[];
  readonly nextAfter: string | null;
}

const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Reflect.ownKeys(v).every((k) => typeof k === 'string' && [...required, ...optional].includes(k));
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && validConversationText(v, max);
const id = (v: unknown): v is string => text(v, 128);
const projectId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const query = (v: Record<string, unknown>, cursor: (v: unknown) => boolean) =>
  id(v['workspaceId']) &&
  (v['after'] === undefined || cursor(v['after'])) &&
  (v['limit'] === undefined ||
    (localPosition(v['limit']) && v['limit'] >= 1 && v['limit'] <= LOCAL_CODING_WORKSPACE_PAGE));

export function isCodingProjectsList(v: unknown): v is CodingProjectsList {
  return (
    localRuntimeRecord(v) && exact(v, ['workspaceId'], ['after', 'limit']) && query(v, projectId)
  );
}
export function isCodingTasksList(v: unknown): v is CodingTasksList {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['workspaceId', 'projectId'], ['after', 'limit']) &&
    projectId(v['projectId']) &&
    query(v, id)
  );
}
export function isCodingProjectSummary(v: unknown): v is CodingProjectSummary {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['id', 'root', 'presetIds']) &&
    projectId(v['id']) &&
    text(v['root'], 4096) &&
    v['root'].startsWith('/') &&
    Array.isArray(v['presetIds']) &&
    v['presetIds'].length <= 16 &&
    Array.from(v['presetIds']).every((p) => text(p, 64)) &&
    new Set(v['presetIds']).size === v['presetIds'].length
  );
}
function isCodingTaskSummary(v: unknown): v is CodingTaskSummary {
  return (
    localRuntimeRecord(v) &&
    exact(v, [
      'id',
      'status',
      'ownerRoomId',
      'devBotId',
      'reviewRoomId',
      'reviewBotId',
      'worktreeReady',
    ]) &&
    id(v['id']) &&
    ['reserved', 'cancelled', 'finalizing', 'finalized'].some((s) => s === v['status']) &&
    id(v['ownerRoomId']) &&
    id(v['devBotId']) &&
    id(v['reviewRoomId']) &&
    id(v['reviewBotId']) &&
    v['devBotId'] !== v['reviewBotId'] &&
    typeof v['worktreeReady'] === 'boolean'
  );
}
function page<T extends { id: string }>(
  rows: unknown,
  nextAfter: unknown,
  summary: (v: unknown) => v is T,
): boolean {
  if (!Array.isArray(rows) || rows.length > LOCAL_CODING_WORKSPACE_PAGE) return false;
  const items: unknown[] = Array.from(rows);
  return (
    items.every(summary) &&
    new Set(items.map((r) => r.id)).size === items.length &&
    (nextAfter === null || (items.length > 0 && nextAfter === items.at(-1)?.id))
  );
}
export function isCodingProjectsPage(v: unknown): v is CodingProjectsPage {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['workspaceId', 'projects', 'nextAfter']) &&
    id(v['workspaceId']) &&
    page(v['projects'], v['nextAfter'], isCodingProjectSummary)
  );
}
export function isCodingTasksPage(v: unknown): v is CodingTasksPage {
  return (
    localRuntimeRecord(v) &&
    exact(v, ['workspaceId', 'projectId', 'tasks', 'nextAfter']) &&
    id(v['workspaceId']) &&
    projectId(v['projectId']) &&
    page(v['tasks'], v['nextAfter'], isCodingTaskSummary)
  );
}
