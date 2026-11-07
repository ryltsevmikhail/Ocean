import {
  isCodingApplyQuery,
  isCodingChangesetRead,
  isCodingProjectsList,
  isCodingReviewQuery,
  isCodingTaskPrepare,
  isCodingTaskReserve,
  isCodingTasksList,
  isLocalRoomListQuery,
  isLocalRoomsQuery,
  type LocalDecision,
  type LocalCodingTaskView,
} from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { z } from 'zod';

export const projectWorkspace = 'ws_ocean';
const workspaceId = z.literal(projectWorkspace);
const id = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'));
export const projectDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectBinding = z.strictObject({ profileId: id, instanceId: id });
const room = { workspaceId, roomId: id };
const task = { ...room, taskId: id };
const receipt = { ...task, requestId: id };
const vote = {
  choice: z.enum(['allow-once', 'deny']),
  expectedVersion: z.int().nonnegative(),
  bindingDigest: projectDigest,
};
export const operationKey = z.strictObject({
  ...receipt,
  operation: z.enum(['reserve', 'prepare', 'review', 'apply']),
});
const devCard = { ...receipt, decisionId: id };
const contract = <T>(check: (value: unknown) => value is T) => z.custom<T>(check);
const validators = {
  projects: contract(isCodingProjectsList),
  tasks: contract(isCodingTasksList),
  rooms: contract(isLocalRoomsQuery),
  members: contract(isLocalRoomListQuery),
  task: z.strictObject(task),
  history: z.strictObject({ ...task, after: z.int().nonnegative() }),
  tests: z.strictObject({ ...task, afterTreeHash: projectDigest }),
  reserve: contract(isCodingTaskReserve),
  prepare: contract(isCodingTaskPrepare),
  capture: contract(isCodingTaskPrepare),
  diff: contract(isCodingChangesetRead),
  review: contract(isCodingReviewQuery),
  apply: contract(isCodingApplyQuery),
  'operation-status': operationKey,
  'operation-card': operationKey,
  'operation-vote': operationKey.extend(vote),
  'dev-card': z.strictObject(devCard),
  'dev-vote': z.strictObject({ ...devCard, ...vote }),
  send: z.strictObject({
    ...receipt,
    text: z
      .string()
      .max(16384)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          !/[\0\uD800-\uDFFF]/u.test(value) &&
          new TextEncoder().encode(value).length <= 16384,
      ),
  }),
  receipt: z.strictObject(receipt),
  observe: z.strictObject(receipt),
  cancel: z.strictObject({ ...receipt, cancelId: id, expectedVersion: z.int().nonnegative() }),
};

export type ProjectBinding = z.infer<typeof projectBinding>;
export type OperationKey = z.infer<typeof operationKey>;
type ProjectInputs = { [K in keyof typeof validators]: z.infer<(typeof validators)[K]> };
type BoundCommand = {
  [K in keyof ProjectInputs]: { op: K; binding: ProjectBinding; input: ProjectInputs[K] };
}[keyof ProjectInputs];
export type ProjectCommand = { op: 'support' } | BoundCommand;
export type ProjectInput<K extends keyof ProjectInputs> = ProjectInputs[K];

const support = z.strictObject({ op: z.literal('support') });
const bound = z.strictObject({ op: z.string(), binding: projectBinding, input: z.unknown() });
export function projectCommand(raw: unknown): ProjectCommand {
  if (support.safeParse(raw).success) return { op: 'support' };
  const cmd = bound.safeParse(raw);
  if (!cmd.success || !Object.hasOwn(validators, cmd.data.op)) throw Error('invalid_request');
  const op = cmd.data.op as keyof ProjectInputs;
  const checked = validators[op].safeParse(cmd.data.input);
  if (!checked.success || checked.data.workspaceId !== projectWorkspace)
    throw Error('invalid_request');
  return { op, binding: cmd.data.binding, input: checked.data } as BoundCommand;
}

type Reply<K extends keyof LocalRuntimeClient> = LocalRuntimeClient[K] extends (
  ...args: never[]
) => Promise<infer R>
  ? R
  : never;
type OperationOutput = {
  reserve: Reply<'reserveCodingTask'>;
  prepare: Reply<'prepareCodingTask'>;
  review: Reply<'requestCodingReview'>;
  apply: Reply<'applyCodingChangeset'>;
};
export type OperationStatus = {
  [K in keyof OperationOutput]: { operation: K; result: OperationOutput[K] };
}[keyof OperationOutput];
export type ProjectTask = Omit<LocalCodingTaskView, 'policy' | 'worktreeRoot'> & {
  worktreeReady: boolean;
};
export type ProjectTest = {
  presetId: string | null;
  hash: string | null;
  state: 'missing' | 'different' | 'passed' | 'failed';
};
export type ProjectCard = { decision: LocalDecision; preview: string };
export type ProjectReplies = OperationOutput & {
  support: ProjectBinding & { supported: boolean };
  projects: Reply<'listCodingProjects'>;
  tasks: Reply<'listCodingTasks'>;
  rooms: Reply<'listRooms'>;
  members: readonly { id: string; name: string; handle: string }[];
  task: ProjectTask;
  history: Reply<'history'>;
  tests: ProjectTest[];
  capture: Reply<'captureCodingChangeset'>;
  diff: Reply<'readCodingChangeset'>;
  'operation-status': OperationStatus;
  'operation-card': ProjectCard;
  'operation-vote': LocalDecision;
  'dev-card': ProjectCard;
  'dev-vote': LocalDecision;
  send: Reply<'submit'>;
  receipt: Reply<'getReceipt'>;
  observe: Reply<'observeRun'>['snapshot'] | null;
  cancel: Reply<'cancelRun'>;
};
