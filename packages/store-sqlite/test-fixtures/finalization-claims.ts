import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodingApproval, CodingApprovalBinding, CodingTask } from '@runnets/domain';
import { CodingApprovalService, dispatchCodingOperation } from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function claimFixture(workspaceId = 'ws') {
  const root = mkdtempSync(join(tmpdir(), 'ocean-claim-finalization-'));
  const path = join(root, 'runtime.sqlite');
  const store = openSqliteStore({ path });
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO ocean_workspace VALUES(1,'ws','/project');
    INSERT INTO ocean_bots VALUES('dev','ws','dev','Dev','Role','test','test',1),
      ('review','ws','review','Review','Role','test','test',1);
    INSERT INTO ocean_rooms(id,workspace_id,kind,bot_id) VALUES
      ('room','ws','direct','dev'),('review-room','ws','direct','review');
    INSERT INTO ocean_members VALUES('ws','room','dev'),('ws','review-room','review');`);
  if (workspaceId !== 'ws') {
    db.exec('PRAGMA foreign_keys=OFF');
    for (const table of ['ocean_workspace', 'ocean_bots', 'ocean_rooms', 'ocean_members'])
      db.prepare(
        `UPDATE ${table} SET ${table === 'ocean_workspace' ? 'id' : 'workspace_id'}=?`,
      ).run(workspaceId);
    db.exec('PRAGMA foreign_keys=ON');
  }
  const task: CodingTask = {
    id: 'task',
    workspaceId,
    projectRoot: '/project',
    worktreeRoot: '/worktree',
    baseCommit: 'a'.repeat(40),
    ownerRoomId: 'room',
    devBotId: 'dev',
    reviewRoomId: 'review-room',
    reviewBotId: 'review',
    status: 'reserved',
    policyVersion: 1,
    policy: {
      version: 1,
      devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
      reviewCapabilities: ['changeset_read'],
      testPresets: [{ id: 'test', program: '/toolchain/node', args: ['test.cjs'], cwd: '.' }],
    },
    lease: {
      ownerId: 'owner',
      taskId: 'task',
      requestId: 'start',
      binding: 'binding',
      kind: 'coding',
      projectRoot: '/project',
      token: 'token',
    },
    createdAt: '2026-11-03T00:00:00.000Z',
  };
  store.coding.atomic((tx) => {
    tx.putTask(task);
    tx.putWorktree({
      taskId: 'task',
      workspaceId,
      root: '/worktree',
      projectRoot: '/project',
      baseCommit: task.baseCommit,
      branch: 'branch',
      gitCommonDir: '/project/.git',
      state: 'ready',
      lease: { ...task.lease, projectRoot: '/worktree', token: 'worktree-token', kind: 'coding' },
    });
  });
  const approvals = new CodingApprovalService({
    store: store.codingApprovals,
    now: () => 100,
    admit: () => true,
    restored: false,
  });
  let sequence = 0;
  function operation(operation: 'write' | 'test') {
    const id = 'approval-' + String(++sequence);
    const binding: CodingApprovalBinding = {
      workspaceId,
      taskId: 'task',
      projectRoot: '/project',
      worktreeRoot: '/worktree',
      roomId: 'room',
      botId: 'dev',
      runId: 'run-' + id,
      attemptId: 'attempt-' + id,
      invocationId: 'invocation-' + id,
      operation,
      operationHash: '1'.repeat(64),
      sourceTreeHash: '2'.repeat(64),
      policyVersion: 1,
      limitsHash: '3'.repeat(64),
      toolchainHash: '4'.repeat(64),
    };
    return { id, binding };
  }
  async function dispatch(kind: 'write' | 'test', exitCode = 0) {
    const { id, binding } = operation(kind);
    const preview =
      kind === 'test'
        ? JSON.stringify({ program: '/toolchain/node', args: ['test.cjs'], cwd: '.' }) + '\nlimits'
        : '--- new file\n+++ after\nlimits';
    const body = {
      presetId: 'test',
      id,
      binding,
      invocationHash: '5'.repeat(64),
      beforeTreeHash: binding.sourceTreeHash,
      afterTreeHash: binding.sourceTreeHash,
      dependencyHash: '6'.repeat(64),
      dependenciesUnchanged: true,
      exitCode,
      reason: 'exit' as const,
      cleanupConfirmed: true,
      truncated: false,
      output: 'result',
    };
    const result = await dispatchCodingOperation(
      {
        approvalId: id,
        binding,
        currentBinding: async () => binding,
        tool: {
          title: kind,
          kind: kind === 'write' ? 'edit' : 'execute',
          preview,
          execute: async () => ({ output: 'result', isError: exitCode !== 0 }),
        },
        ...(kind === 'test'
          ? { recordResult: () => store.codingEvidence.put({ ...body, hash: hash(body) }) }
          : {}),
      },
      approvals,
      { decide: async () => 'allow-once' },
      store.tools,
      new AbortController().signal,
    );
    if (result.uncertain) throw Error('fixture dispatch uncertain');
    return { id, binding };
  }
  const rows = () =>
    Object.fromEntries(
      [
        'ocean_coding_approvals',
        'ocean_coding_approval_claims',
        'tool_invocations_v2',
        'ocean_coding_test_evidence',
      ].map((table) => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]),
    );
  const holds = () => store.finalization.atomic((tx) => tx.holds('task'));
  const approval = (id: string) => store.codingApprovals.atomic((tx) => tx.approval(id))!;
  const changeApproval = (id: string, change: (value: CodingApproval) => CodingApproval) =>
    db
      .prepare('UPDATE ocean_coding_approvals SET payload=? WHERE id=?')
      .run(JSON.stringify(change(approval(id))), id);
  const changeEvidence = (id: string, change: (body: Record<string, unknown>) => void) => {
    const evidence = store.codingEvidence.list('task').find((e) => e.id === id)!;
    const { hash: _old, ...body } = evidence;
    change(body);
    db.prepare('UPDATE ocean_coding_test_evidence SET hash=?,payload=? WHERE id=?').run(
      hash(body),
      JSON.stringify({ ...body, hash: hash(body) }),
      id,
    );
  };
  return {
    root,
    path,
    db,
    store,
    task,
    approvals,
    dispatch,
    operation,
    holds,
    rows,
    approval,
    changeApproval,
    changeEvidence,
    close() {
      db.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
