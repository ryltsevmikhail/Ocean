import {
  LOCAL_CODING_WORKSPACE,
  isCodingView,
  type LocalRoomScope,
  type LocalCodingTaskView,
} from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import {
  type ProjectCommand,
  type ProjectInput,
  type ProjectReplies,
  type ProjectTest,
} from '../project-protocol.js';
import { devCard, operationCard, operationStatus, vote } from './project-decisions.js';
export { projectCommand } from '../project-protocol.js';

type Scope = LocalRoomScope & { taskId: string };
function roomScope({ workspaceId, roomId }: LocalRoomScope) {
  return { workspaceId, roomId };
}
async function scopedTask(client: LocalRuntimeClient, q: Scope, role: 'dev' | 'review' = 'dev') {
  const input = {
    workspaceId: q.workspaceId,
    id: q.taskId,
    ...(role === 'dev' ? { roomId: q.roomId } : {}),
  };
  const task = (await client.codingRead('coding.show', input)) as LocalCodingTaskView;
  if (
    task.id !== q.taskId ||
    task.workspaceId !== q.workspaceId ||
    task[role === 'dev' ? 'ownerRoomId' : 'reviewRoomId'] !== q.roomId
  )
    throw Error('coding_denied');
  return task;
}
async function receiptFor(client: LocalRuntimeClient, q: ProjectInput<'receipt'>) {
  return client.getReceipt({ ...roomScope(q), requestId: q.requestId, taskId: q.taskId });
}
async function observe(
  client: LocalRuntimeClient,
  q: ProjectInput<'receipt'>,
  task: LocalCodingTaskView,
) {
  const receipt = await receiptFor(client, q);
  if (!receipt?.runId) return null;
  const { snapshot } = await client.observeRun({
    ...roomScope(q),
    runId: receipt.runId,
    waitMs: 0,
  });
  if (snapshot.requestId !== q.requestId || snapshot.performerId !== task.devBotId)
    throw Error('coding_denied');
  return snapshot;
}
async function tests(client: LocalRuntimeClient, q: ProjectInput<'tests'>): Promise<ProjectTest[]> {
  const input = { ...roomScope(q), id: q.taskId };
  const panel = await client.codingRead('coding.diff', input);
  if (!isCodingView(panel, 'coding.diff', input) || !('tests' in panel))
    throw Error('invalid_frame');
  if (panel.kind === 'frozen')
    return panel.tests.map((t) => ({
      presetId: t.presetId,
      hash: t.hash,
      state: t.afterTreeHash !== q.afterTreeHash ? 'different' : t.passed ? 'passed' : 'failed',
    }));
  return panel.tests.map(({ presetId, evidence }) => ({
    presetId,
    hash: evidence?.hash ?? null,
    state: !evidence
      ? 'missing'
      : evidence.afterTreeHash !== q.afterTreeHash || !evidence.current
        ? 'different'
        : evidence.passed
          ? 'passed'
          : 'failed',
  }));
}
export async function dispatchProject(
  client: LocalRuntimeClient,
  c: ProjectCommand,
): Promise<ProjectReplies[keyof ProjectReplies]> {
  const { profileId, instanceId, capabilities } = client.identity;
  const supported = capabilities.includes(LOCAL_CODING_WORKSPACE);
  if (c.op === 'support') return { profileId, instanceId, supported };
  if (!supported) throw Error('project_runtime_upgrade_required');
  if (c.binding.profileId !== profileId || c.binding.instanceId !== instanceId)
    throw Error('project_identity_changed');
  switch (c.op) {
    case 'projects':
      return client.listCodingProjects(c.input);
    case 'tasks':
      return client.listCodingTasks(c.input);
    case 'rooms':
      return client.listRooms(c.input);
    case 'members':
      return (await client.listMembers(c.input)).map(({ id, name, handle }) => ({
        id,
        name,
        handle,
      }));
    case 'reserve':
      return client.reserveCodingTask(c.input);
    case 'prepare':
      return client.prepareCodingTask(c.input);
    case 'capture':
      return client.captureCodingChangeset(c.input);
    case 'diff':
      return client.readCodingChangeset(c.input);
    case 'review':
      await scopedTask(client, c.input, 'review');
      return client.requestCodingReview(c.input);
    case 'apply':
      return client.applyCodingChangeset(c.input);
    case 'operation-status':
      return operationStatus(client, c.input);
    case 'operation-card':
      return (await operationCard(client, c.input)).card;
    case 'operation-vote': {
      const { ref, card } = await operationCard(client, c.input);
      return vote(client, ref, card, c.input);
    }
    case 'task':
    case 'tests':
    case 'history':
    case 'send':
    case 'receipt':
    case 'observe':
    case 'cancel':
    case 'dev-card':
    case 'dev-vote':
      break;
  }
  const { input } = c;
  const task = await scopedTask(client, input);
  switch (c.op) {
    case 'task': {
      const { policy: _policy, worktreeRoot, ...view } = task;
      return { ...view, worktreeReady: worktreeRoot !== null };
    }
    case 'tests':
      return tests(client, c.input);
    case 'history':
      return client.history({ ...roomScope(input), after: c.input.after, limit: 30 });
    case 'send':
      if (task.status !== 'reserved' || !task.worktreeRoot) throw Error('coding_denied');
      return client.submit({ ...c.input, to: task.devBotId });
    case 'receipt':
      return receiptFor(client, c.input);
    case 'observe':
      return observe(client, c.input, task);
    case 'cancel': {
      const run = await observe(client, c.input, task);
      if (!run) throw Error('run_unavailable');
      return client.cancelRun({
        ...roomScope(input),
        runId: run.runId,
        expectedVersion: c.input.expectedVersion,
        requestId: c.input.cancelId,
      });
    }
    case 'dev-card':
    case 'dev-vote': {
      const run = await observe(client, c.input, task);
      if (!run?.pendingDecisionIds.includes(c.input.decisionId))
        throw Error('decision_scope_changed');
      const ref = { ...roomScope(input), runId: run.runId, decisionId: c.input.decisionId };
      const card = await devCard(client, ref);
      return c.op === 'dev-card' ? card : vote(client, ref, card, c.input);
    }
  }
}
