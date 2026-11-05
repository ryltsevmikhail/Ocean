import { createHash } from 'node:crypto';
import type { CodingTask } from '@runnets/domain';
import {
  CodingTaskService,
  CodingApprovalService,
  OwnerScopeService,
  codingApprovalAdmission,
  dispatchCodingOperation,
  type CodingServiceDeps,
} from '@runnets/application';
import { claimFixture } from './finalization-claims.js';
export const projectId = (root: string) => createHash('sha256').update(root).digest('hex');
export function consumerFixture() {
  const f = claimFixture();
  const b: CodingTask = {
    ...f.task,
    id: 'task-b',
    projectRoot: '/other-project',
    worktreeRoot: '/other-worktree',
    lease: { ...f.task.lease, taskId: 'task-b', projectRoot: '/other-project', token: 'token-b' },
  };
  const original = f.store.coding.atomic((tx) => tx.worktree(f.task.id))!;
  f.store.coding.atomic((tx) => {
    tx.putTask(b);
    tx.putWorktree({
      ...original,
      taskId: b.id,
      root: b.worktreeRoot!,
      projectRoot: b.projectRoot,
      lease: { ...b.lease, projectRoot: b.worktreeRoot!, token: 'worktree-b' },
    });
  });
  const live = new Set(['token', 'worktree-token', 'token-b', 'worktree-b']);
  const deps: CodingServiceDeps & { projectId: typeof projectId } = {
    store: f.store.coding,
    journal: f.store.tools,
    ownerId: 'owner',
    projectId,
    clock: { now: () => new Date(100) },
    projects: { inspect: async (root) => ({ root, baseCommit: b.baseCommit, clean: true }) },
    leases: {
      acquire: (root, holder) => {
        live.add(holder.taskId);
        return { ok: true, value: { ...holder, projectRoot: root, token: holder.taskId } };
      },
      owns: (lease) => live.has(lease.token),
      release: (lease) => live.delete(lease.token),
    },
  };
  const tasks = new CodingTaskService(deps);
  const owners = new OwnerScopeService(f.store.serviceAuthority, 'owner', () => 100);
  const approvals = new CodingApprovalService({
    store: f.store.codingApprovals,
    grantOwnerId: 'owner',
    restored: false,
    now: () => 100,
    admit: (binding, tx, approval) => codingApprovalAdmission(binding, tx, deps, approval),
  });
  const access = (task = b) => ({
    taskId: task.id,
    workspaceId: task.workspaceId,
    roomId: task.ownerRoomId,
    botId: task.devBotId,
    policyVersion: 1,
    capability: 'project_read' as const,
  });
  function grant(task = b) {
    return owners.issue({
      id: 'grant-' + task.id,
      subject: {
        workspaceId: task.workspaceId,
        roomId: task.ownerRoomId,
        botId: task.devBotId,
        projectId: projectId(task.projectRoot),
        taskId: task.id,
      },
      permissions: [
        {
          kind: 'coding',
          actions: ['propose_write', 'run_test_preset'],
          resources: [
            {
              kind: 'project-worktree',
              projectId: projectId(task.projectRoot),
              worktreeId: task.id,
            },
          ],
        },
      ],
      limits: { maxCalls: 10, maxEffectBytes: 16384, expiresAt: null },
    });
  }
  let sends = 0;
  async function uncertainA() {
    grant(f.task);
    const { id, binding } = f.operation('write');
    const result = await dispatchCodingOperation(
      {
        approvalId: id,
        binding,
        guarded: true,
        currentBinding: async () => binding,
        tool: {
          title: 'write',
          kind: 'edit',
          preview: 'exact edit',
          execute: async (_signal, guard) => {
            if (!guard?.authorize()) throw Error('dispatch refused');
            sends++;
            return { output: 'unknown after send', isError: true, uncertain: true };
          },
        },
      },
      approvals,
      { decide: async () => 'allow-once' },
      f.store.tools,
      new AbortController().signal,
    );
    if (!result.uncertain || sends !== 1) throw Error('fixture must send exactly once');
    return { id, binding };
  }
  function aRows() {
    return {
      task: f.db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').all(f.task.id),
      worktree: f.db.prepare('SELECT * FROM ocean_worktrees WHERE task_id=?').all(f.task.id),
      approvals: f.db
        .prepare(
          "SELECT * FROM ocean_coding_approvals WHERE json_extract(payload,'$.binding.taskId')=?",
        )
        .all(f.task.id),
      claims: f.db
        .prepare(
          "SELECT * FROM ocean_coding_approval_claims WHERE json_extract(invocation_key,'$[1]')=?",
        )
        .all(f.task.id),
      effects: f.db
        .prepare(
          "SELECT * FROM tool_invocations_v2 WHERE json_extract(admission,'$.binding.taskId')=?",
        )
        .all(f.task.id),
      grant: f.db.prepare('SELECT * FROM ocean_owner_scope_grants WHERE id=?').all('grant-task'),
      calls: f.store.serviceAuthority.atomic((tx) => tx.grantCalls('run-approval-1', 'grant-task')),
    };
  }
  return {
    ...f,
    aRows,
    b,
    deps,
    tasks,
    owners,
    approvals,
    access,
    grant,
    live,
    uncertainA,
    sends: () => sends,
  };
}
