import { validConversationText } from '@runnets/domain';
import { localRuntimeRecord } from './local-runtime.js';
import { isLocalDecision, type LocalDecision } from './local-runtime-decisions.js';
import { isCodingTaskSummary, type CodingTaskSummary } from './local-runtime-projects.js';

export interface CodingTaskReserve {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly ownerRoomId: string;
  readonly devBotId: string;
  readonly reviewRoomId: string;
  readonly reviewBotId: string;
}
export interface CodingTaskReservation {
  readonly decision: LocalDecision;
  /** Only an exact service receipt establishes reserved; allowed is still in progress. */
  readonly status: LocalDecision['status'] | 'reserved' | 'unconfirmed';
  readonly task: Omit<CodingTaskSummary, 'worktreeReady'> | null;
}
const keys = [
  'workspaceId',
  'projectId',
  'requestId',
  'taskId',
  'ownerRoomId',
  'devBotId',
  'reviewRoomId',
  'reviewBotId',
];
export function isCodingTaskReserve(v: unknown): v is CodingTaskReserve {
  return (
    localRuntimeRecord(v) &&
    Reflect.ownKeys(v).length === keys.length &&
    keys.every(
      (k) => Object.hasOwn(v, k) && typeof v[k] === 'string' && validConversationText(v[k], 128),
    ) &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(String(v['projectId'])) &&
    v['devBotId'] !== v['reviewBotId']
  );
}
export function isCodingTaskReservation(v: unknown): v is CodingTaskReservation {
  return (
    localRuntimeRecord(v) &&
    Object.keys(v).length === 3 &&
    isLocalDecision(v['decision']) &&
    v['decision'].kind === 'project-setup' &&
    (v['status'] === 'reserved'
      ? v['decision'].status === 'allowed' &&
        localRuntimeRecord(v['task']) &&
        !Object.hasOwn(v['task'], 'worktreeReady') &&
        isCodingTaskSummary({ ...v['task'], worktreeReady: false })
      : v['task'] === null &&
        (v['status'] === v['decision'].status ||
          (v['status'] === 'unconfirmed' && v['decision'].status === 'allowed')))
  );
}
