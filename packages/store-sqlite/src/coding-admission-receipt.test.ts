import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  OwnerScopeService,
  CodingApprovalService,
  codingApprovalAdmission,
  dispatchCodingOperation,
} from '@runnets/application';
import type { CodingApprovalBinding, ToolEffectAdmission } from '@runnets/domain';
import { claimFixture } from '../test-fixtures/finalization-claims.js';
const damage = ['missing', 'malformed', 'scope', 'kind', 'binding', 'grant', 'revision'] as const;
type Damage = (typeof damage)[number];
const project = (root: string) => createHash('sha256').update(root).digest('hex');
function fixture(autonomous = false) {
  const f = claimFixture(),
    approvals = new CodingApprovalService({
      store: f.store.codingApprovals,
      grantOwnerId: 'owner',
      now: () => 100,
      restored: false,
      admit: (b, tx, a) =>
        codingApprovalAdmission(
          b,
          tx,
          {
            ownerId: 'owner',
            leases: {
              owns: () => true,
              release: () => false,
              acquire: () => {
                throw Error('unused');
              },
            },
            journal: f.store.tools,
          },
          a,
        ),
    });
  if (autonomous)
    new OwnerScopeService(f.store.serviceAuthority, 'owner', () => 100).issue({
      id: 'g',
      subject: {
        workspaceId: 'ws',
        roomId: 'room',
        botId: 'dev',
        taskId: 'task',
        projectId: project('/project'),
      },
      permissions: [
        {
          kind: 'coding',
          actions: ['propose_write'],
          resources: [
            { kind: 'project-worktree', projectId: project('/project'), worktreeId: 'task' },
          ],
        },
      ],
      limits: { maxCalls: 1, maxEffectBytes: 4096, expiresAt: null },
    });
  const op = f.operation('write');
  function corrupt(mode: Damage) {
    const column = f.db
      .prepare('SELECT admission FROM tool_invocations_v2 WHERE id=?')
      .get(op.binding.invocationId)?.['admission'];
    const original = JSON.parse(String(column)) as ToolEffectAdmission;
    const changes = {
      missing: null,
      malformed: {},
      scope: { ...original, scope: { kind: 'legacy-global-unknown' } },
      kind: { ...original, effectKind: 'observation' },
      binding: { ...original, binding: { ...op.binding, limitsHash: 'other' } },
      grant: { ...original, grantReference: { grantId: 'other', revision: 1 } },
      revision: { ...original, grantReference: { grantId: 'g', revision: 2 } },
    };
    const changed = changes[mode];
    f.db
      .prepare('UPDATE tool_invocations_v2 SET admission=? WHERE id=?')
      .run(changed === null ? null : JSON.stringify(changed), op.binding.invocationId);
  }
  function dispatch(beforeSend = () => {}, allow = true) {
    let sends = 0;
    return dispatchCodingOperation(
      {
        approvalId: op.id,
        binding: op.binding,
        guarded: true,
        currentBinding: async () => op.binding,
        tool: {
          title: 'write',
          preview: 'before -> after',
          kind: 'edit',
          execute: async (_sig, guard) => {
            beforeSend();
            if (!allow || !guard?.authorize()) throw Error('no send');
            sends++;
            return { output: 'ok', isError: false };
          },
        },
      },
      approvals,
      { decide: async () => 'allow-once' },
      f.store.tools,
      new AbortController().signal,
    ).then((result) => ({ result, sends }));
  }
  return { f, op, approvals, corrupt, dispatch };
}
for (const autonomous of [true, false]) {
  it.each(damage)(
    'refuses dispatch and retains a hold for damaged ' +
      (autonomous ? 'autonomous' : 'human') +
      ' receipt: %s',
    async (mode) => {
      const { f, op, corrupt, dispatch } = fixture(autonomous);
      try {
        const { sends, result } = await dispatch(() => corrupt(mode));
        expect(sends).toBe(0);
        expect(result.isError).toBe(true);
        expect(f.approval(op.id).status).toBe('consumed');
        expect(f.holds().some((h) => h.kind === 'claim')).toBe(true);
        expect((await dispatch()).sends).toBe(0);
        if (autonomous)
          expect(
            f.store.serviceAuthority.atomic((tx) => tx.grantCalls(op.binding.runId, 'g')),
          ).toBe(1);
        expect(
          f.store.serviceAuthority.atomic((tx) => tx.grantCalls(op.binding.runId, 'other')),
        ).toBe(0);
      } finally {
        f.close();
      }
    },
  );
  it.each([true, false])(
    'holds previously quiescent damaged ' +
      (autonomous ? 'autonomous' : 'human') +
      ' completed/not-started receipt for send=%s',
    async (send) => {
      const { f, corrupt, dispatch } = fixture(autonomous);
      try {
        expect((await dispatch(() => {}, send)).sends).toBe(Number(send));
        expect(f.holds().filter((h) => h.kind === 'claim')).toEqual([]);
        corrupt('scope');
        expect(f.holds().some((h) => h.kind === 'claim')).toBe(true);
      } finally {
        f.close();
      }
    },
  );
}
function secondBinding(f: ReturnType<typeof claimFixture>): CodingApprovalBinding {
  const { binding } = f.operation('write');
  const task = {
    ...f.task,
    id: 'two',
    projectRoot: '/other-project',
    worktreeRoot: '/other-tree',
    lease: { ...f.task.lease, taskId: 'two', projectRoot: '/other-project' },
  };
  f.store.coding.atomic((tx) => {
    tx.putTask(task);
    tx.putWorktree({
      ...tx.worktree('task')!,
      taskId: task.id,
      root: task.worktreeRoot,
      projectRoot: task.projectRoot,
      lease: { ...task.lease, projectRoot: task.worktreeRoot },
    });
  });
  return {
    ...binding,
    taskId: task.id,
    projectRoot: task.projectRoot,
    worktreeRoot: task.worktreeRoot,
  };
}
it.each([false, true])(
  'treats an outstanding guarded=%s host effect conservatively against a second task',
  async (guarded) => {
    const { f, op, approvals, dispatch } = fixture();
    try {
      const b = secondBinding(f);
      if (guarded) await dispatch();
      else {
        expect(approvals.request(op.id, op.binding, 'write').ok).toBe(true);
        expect(
          (await approvals.decide(op.id, op.binding, { decide: async () => 'allow-once' })).ok,
        ).toBe(true);
        expect(approvals.consume(op.id, op.binding).ok).toBe(true);
      }
      f.db
        .prepare("UPDATE tool_invocations_v2 SET outcome='uncertain' WHERE id=?")
        .run(op.binding.invocationId);
      const row = f.db
        .prepare('SELECT admission FROM tool_invocations_v2 WHERE id=?')
        .get(op.binding.invocationId);
      expect(row?.['admission'] === null).toBe(!guarded);
      expect(approvals.request('other-unguarded', b, 'write', false).ok).toBe(false);
      expect(approvals.request('other-guarded', b, 'write', true).ok).toBe(guarded);
      if (guarded) {
        f.db.prepare('DELETE FROM ocean_coding_approval_claims WHERE approval_id=?').run(op.id);
        expect(approvals.request('orphaned', b, 'write', true).ok).toBe(false);
      }
      if (!guarded) {
        // An early C18.3 unguarded host may already have written narrow metadata.
        const incorrect: ToolEffectAdmission = {
          effectKind: 'mutation',
          scope: {
            kind: 'resources',
            resources: [
              { kind: 'project-worktree', projectId: project('/project'), worktreeId: 'task' },
            ],
          },
          grantReference: null,
          binding: { ...op.binding },
        };
        f.db
          .prepare('UPDATE tool_invocations_v2 SET admission=? WHERE id=?')
          .run(JSON.stringify(incorrect), op.binding.invocationId);
        expect(approvals.request('past-unguarded', b, 'write', true).ok).toBe(false);
      }
    } finally {
      f.close();
    }
  },
);

it.each(['decide', 'consume'] as const)(
  'keeps the legacy %s global when another guarded effect starts after the request',
  async (phase) => {
    const { f, op, approvals, dispatch } = fixture();
    try {
      const second = secondBinding(f);
      expect(approvals.request('legacy', second, 'write').ok).toBe(true);
      if (phase === 'consume')
        expect(
          (await approvals.decide('legacy', second, { decide: async () => 'allow-once' })).ok,
        ).toBe(true);
      expect((await dispatch()).sends).toBe(1);
      f.db
        .prepare("UPDATE tool_invocations_v2 SET outcome='uncertain' WHERE id=?")
        .run(op.binding.invocationId);
      const result =
        phase === 'decide'
          ? await approvals.decide('legacy', second, {
              decide: async () => {
                throw Error('must not prompt');
              },
            })
          : approvals.consume('legacy', second);
      expect(result.ok).toBe(false);
    } finally {
      f.close();
    }
  },
);
