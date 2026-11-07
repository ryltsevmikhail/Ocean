import { afterEach, expect, it } from 'vitest';
import { CodingTaskService, codingApplyAdmission } from '@runnets/application';
import { consumerFinalization } from '../test-fixtures/coding-consumer-finalization.js';
import { consumerFixture, projectId } from '../test-fixtures/coding-consumer.js';
const fixtures: ReturnType<typeof consumerFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const setup = () => {
  const f = consumerFixture();
  fixtures.push(f);
  return f;
};
it('authorizes the disjoint normal coding service while A remains uncertain and spent', async () => {
  const f = setup();
  await f.uncertainA();
  const before = f.rows();
  expect(f.tasks.authorize(f.access())).toEqual({
    ok: true,
    value: { taskId: f.b.id, executionEnabled: false },
  });
  expect(f.tasks.authorize(f.access(f.task))).toMatchObject({
    ok: false,
    error: { code: 'recovery_required' },
  });
  expect(f.rows()).toEqual(before);
});
it('previews and owner-finalizes only B with actual SQLite journal/claims/decisions', async () => {
  const f = setup();
  await f.uncertainA();
  const before = f.rows(),
    aHolds = f.holds();
  const { owner, service, selection, released } = consumerFinalization(f);
  try {
    const card = await service.preview(selection, new AbortController().signal);
    await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
    await service.join();
    expect(service.result(selection)).toMatchObject({
      state: 'finalized',
      taskStatus: 'finalized',
    });
    expect(released).toEqual([f.b.id]);
    expect(f.rows()).toEqual(before);
    expect(f.holds()).toEqual(aHolds);
    expect(f.live.has(f.task.lease.token)).toBe(true);
  } finally {
    await service.close();
  }
});
it.each([
  'no-mapper',
  'bad-mapper',
  'throwing-mapper',
  'no-inspector',
  'no-worktree',
  'lease',
] as const)('retains conservative service fallback for %s', async (mode) => {
  const f = setup();
  await f.uncertainA();
  const deps = { ...f.deps };
  if (mode === 'no-mapper') delete (deps as Partial<typeof deps>).projectId;
  if (mode === 'bad-mapper') deps.projectId = () => '';
  if (mode === 'throwing-mapper')
    deps.projectId = () => {
      throw Error('unavailable');
    };
  if (mode === 'no-inspector')
    deps.journal = {
      claim: (...args) => f.store.tools.claim(...args),
      settle: (...args) => f.store.tools.settle(...args),
      pending: (...args) => f.store.tools.pending(...args),
      recover: (...args) => f.store.tools.recover(...args),
      inspectPending: () => f.store.tools.inspectPending!(),
    };
  if (mode === 'no-worktree')
    f.db.prepare('DELETE FROM ocean_worktrees WHERE task_id=?').run(f.b.id);
  if (mode === 'lease') f.live.delete('worktree-b');
  expect(new CodingTaskService(deps).authorize(f.access())).toMatchObject({ ok: false });
});
it.each(['same-root', 'alias', 'nested', 'same-worktree', 'equal-id'] as const)(
  'preserves %s conflicts at the service and finalization consumers',
  async (mode) => {
    const f = setup();
    await f.uncertainA();
    if (mode === 'same-root' || mode === 'same-worktree') {
      expect(() =>
        mode === 'same-root'
          ? f.db
              .prepare('UPDATE ocean_coding_tasks SET project_root=? WHERE id=?')
              .run('/project', f.b.id)
          : f.db
              .prepare('UPDATE ocean_worktrees SET root=? WHERE task_id=?')
              .run('/worktree', f.b.id),
      ).toThrow('UNIQUE');
      expect(f.tasks.authorize(f.access(f.task))).toMatchObject({ ok: false });
      return;
    }
    const root = f.b.projectRoot;
    const wtRoot =
      mode === 'alias' ? '/WORKTREE' : mode === 'nested' ? '/worktree/sub' : f.b.worktreeRoot!;
    const task = {
      ...f.b,
      projectRoot: root,
      worktreeRoot: wtRoot,
      lease: { ...f.b.lease, projectRoot: root },
    };
    const worktree = f.store.coding.atomic((tx) => tx.worktree(f.b.id))!;
    const wt = {
      ...worktree,
      root: wtRoot,
      projectRoot: root,
      lease: { ...worktree.lease, projectRoot: wtRoot },
    };
    f.db
      .prepare('UPDATE ocean_coding_tasks SET project_root=?,payload=? WHERE id=?')
      .run(root, JSON.stringify(task), task.id);
    f.db
      .prepare('UPDATE ocean_worktrees SET root=?,payload=? WHERE task_id=?')
      .run(wtRoot, JSON.stringify(wt), task.id);
    const deps =
      mode === 'equal-id' ? { ...f.deps, projectId: () => projectId('/project') } : f.deps;
    expect(new CodingTaskService(deps).authorize(f.access())).toMatchObject({ ok: false });
    if (mode !== 'equal-id')
      expect(f.store.finalization.atomic((tx) => tx.holds(task.id)).length).toBeGreaterThan(0);
  },
);
it.each([
  'admission',
  'approval',
  'claim',
  'fingerprint',
  'journal',
  'unguarded',
  'owning-task',
] as const)('keeps foreign unquiescent claim global on missing/contradictory %s', async (mode) => {
  const f = setup();
  const op = await f.uncertainA();
  f.db.exec("UPDATE tool_invocations_v2 SET outcome='failed'");
  if (mode === 'admission') f.db.exec('UPDATE tool_invocations_v2 SET admission=NULL');
  if (mode === 'approval') f.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM ocean_coding_approvals');
  if (mode === 'claim') f.db.exec("UPDATE ocean_coding_approval_claims SET invocation_key='wrong'");
  if (mode === 'fingerprint') f.db.exec("UPDATE tool_invocations_v2 SET fingerprint='wrong'");
  if (mode === 'journal') f.db.exec('DELETE FROM tool_invocations_v2');
  if (mode === 'unguarded')
    f.changeApproval(op.id, (a) => {
      const { guardedDispatch: _guarded, ...legacy } = a;
      return legacy;
    });
  if (mode === 'owning-task')
    f.db.exec("PRAGMA foreign_keys=OFF; DELETE FROM ocean_coding_tasks WHERE id='task'");
  const before = f.rows();
  expect(f.store.finalization.atomic((tx) => tx.holds(f.b.id))).toContainEqual(
    expect.objectContaining({ kind: 'claim', scope: 'global' }),
  );
  expect(f.rows()).toEqual(before);
});
it('leaves unguarded B approval and source apply admission globally blocked', async () => {
  const f = setup();
  await f.uncertainA();
  const { binding } = f.operation('write');
  const b = {
    ...binding,
    taskId: f.b.id,
    projectRoot: f.b.projectRoot,
    worktreeRoot: f.b.worktreeRoot!,
  };
  expect(f.approvals.request('legacy-b', b, 'edit', false)).toMatchObject({ ok: false });
  const result = f.store.codingApplications.atomic((tx) =>
    codingApplyAdmission(f.b, tx, { ...f.deps, restored: false }),
  );
  expect(result).toBe(false);
});

it.each(['uncertain', 'failed'] as const)(
  'keeps a coding claim global after contradictory tool with outcome %s',
  async (outcome) => {
    const f = setup();
    await f.uncertainA();
    if (outcome === 'uncertain') f.db.exec("UPDATE tool_invocations_v2 SET tool='command'");
    else
      f.db.exec(
        "UPDATE tool_invocations_v2 SET tool='command',fingerprint='wrong',outcome='failed'",
      );
    const before = f.aRows(),
      holds = f.holds();
    if (outcome === 'uncertain') {
      expect(f.store.tools.inspectPending!()).toHaveLength(1);
      expect(f.tasks.authorize(f.access())).toMatchObject({ ok: false });
    }
    expect(f.store.finalization.atomic((tx) => tx.holds(f.b.id))).toContainEqual(
      expect.objectContaining({ kind: 'claim', scope: 'global' }),
    );
    const { service, selection, released } = consumerFinalization(f);
    try {
      await expect(service.preview(selection, new AbortController().signal)).rejects.toThrow(
        'finalization_effects_held',
      );
      expect(released).toEqual([]);
    } finally {
      await service.close();
    }
    expect(f.aRows()).toEqual(before);
    expect(f.holds()).toEqual(holds);
    expect(f.sends()).toBe(1);
  },
);

it.each(['command', 'coding_write'])(
  'preserves unrelated noncoding %s receipt beside a coding claim',
  async (tool) => {
    const f = setup();
    await f.uncertainA();
    const admission = {
      effectKind: 'mutation',
      scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: 'remote' }] },
      grantReference: { grantId: 'remote-grant', revision: 1 },
      binding: { connectionId: 'remote' },
    };
    f.db
      .prepare(
        'INSERT INTO tool_invocations_v2(id,tool,task_run_id,attempt_id,fingerprint,outcome,admission) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'remote',
        tool,
        'remote-run',
        'remote-attempt',
        'remote-fingerprint',
        'uncertain',
        JSON.stringify(admission),
      );
    const before = f.rows();
    expect(f.store.tools.inspectPending!().find((row) => row.id === 'remote')?.admission).toEqual(
      admission,
    );
    expect(
      f.store.serviceAuthority.atomic((tx) => tx.grantCalls('remote-run', 'remote-grant')),
    ).toBe(1);
    expect(f.rows()).toEqual(before);
  },
);
