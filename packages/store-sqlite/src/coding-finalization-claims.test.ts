import { afterEach, expect, it } from 'vitest';
import { claimFixture, hash } from '../test-fixtures/finalization-claims.js';
const fixtures: ReturnType<typeof claimFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const setup = () => {
  const f = claimFixture();
  fixtures.push(f);
  return f;
};
it('treats exact completed writes and passed/failed cleaned tests as historical spent claims', async () => {
  const f = setup();
  const write = await f.dispatch('write');
  await f.dispatch('test');
  await f.dispatch('test', 3);
  const before = f.rows();
  expect(f.holds()).toEqual([]);
  // Revalidation is read-only, and old source snapshots are not compared to later trees.
  expect(f.holds()).toEqual([]);
  expect(f.rows()).toEqual(before);
  expect(f.approvals.consume(write.id, write.binding)).toMatchObject({ ok: false });
  expect(f.approval(write.id).status).toBe('consumed');
  expect(f.db.prepare('SELECT count(*) AS n FROM ocean_coding_approval_claims').get()?.['n']).toBe(
    3,
  );
});
it.each(['started', 'uncertain', 'not_started', 'failed'] as const)(
  'keeps a write held when its exact journal is %s',
  async (outcome) => {
    const f = setup();
    const operation = await f.dispatch('write');
    f.db
      .prepare('UPDATE tool_invocations_v2 SET outcome=? WHERE id=?')
      .run(outcome, operation.binding.invocationId);
    expect(f.holds().length).toBeGreaterThan(0);
  },
);
it.each(['tool', 'task_run_id', 'attempt_id', 'id', 'fingerprint'] as const)(
  'requires the exact journal %s rather than some completed row',
  async (column) => {
    const f = setup();
    const operation = await f.dispatch('write');
    f.db
      .prepare('UPDATE tool_invocations_v2 SET ' + column + '=? WHERE id=?')
      .run('wrong', operation.binding.invocationId);
    expect(f.holds()).toContainEqual(expect.objectContaining({ kind: 'claim' }));
  },
);
it.each([
  'workspaceId',
  'taskId',
  'projectRoot',
  'worktreeRoot',
  'roomId',
  'botId',
  'runId',
  'attemptId',
  'invocationId',
  'operation',
  'operationHash',
  'sourceTreeHash',
  'limitsHash',
  'toolchainHash',
  'policyVersion',
] as const)('keeps a claim held on contradictory approval binding %s', async (field) => {
  const f = setup();
  const operation = await f.dispatch('test');
  f.changeApproval(operation.id, (a) => ({
    ...a,
    binding: { ...a.binding, [field]: field === 'policyVersion' ? 2 : 'wrong' },
  }));
  expect(f.holds().length).toBeGreaterThan(0);
});
it.each(['allowed', 'pending', 'denied'] as const)(
  'never treats a %s approval as a spent, settled claim',
  async (status) => {
    const f = setup();
    const operation = await f.dispatch('write');
    f.changeApproval(operation.id, (a) => ({ ...a, status }));
    expect(f.holds().length).toBeGreaterThan(0);
  },
);
it.each([
  'missing journal',
  'missing claim',
  'wrong key',
  'malformed key',
  'missing approval',
  'wrong approval id',
  'extra approval shape',
  'extra binding shape',
])('holds %s without changing history', async (mode) => {
  const f = setup();
  const operation = await f.dispatch('write');
  if (mode === 'missing journal') f.db.exec('DELETE FROM tool_invocations_v2');
  else if (mode === 'missing claim') f.db.exec('DELETE FROM ocean_coding_approval_claims');
  else if (mode.endsWith('key'))
    f.db
      .prepare('UPDATE ocean_coding_approval_claims SET invocation_key=?')
      .run(mode === 'wrong key' ? '["ws","other","room","dev","run","attempt","invocation"]' : '{');
  else if (mode === 'missing approval')
    f.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM ocean_coding_approvals');
  else
    f.changeApproval(operation.id, (a) =>
      mode === 'wrong approval id'
        ? { ...a, id: 'wrong' }
        : mode === 'extra approval shape'
          ? { ...a, extra: 'unknown' }
          : { ...a, binding: { ...a.binding, extra: 'unknown' } },
    );
  const before = f.rows();
  expect(f.holds().length).toBeGreaterThan(0);
  expect(f.rows()).toEqual(before);
});

it.each([true, false])(
  'keeps other-task unproven claims globally held (owning task present: %s)',
  async (present) => {
    const f = setup();
    const operation = await f.dispatch('write');
    const a = f.approval(operation.id);
    const binding = {
      ...a.binding,
      taskId: 'other',
      projectRoot: '/other',
      worktreeRoot: '/other-wt',
    };
    if (present)
      f.store.coding.atomic((tx) =>
        tx.putTask({ ...f.task, id: 'other', projectRoot: '/other', worktreeRoot: '/other-wt' }),
      );
    f.changeApproval(a.id, () => ({ ...a, binding }));
    f.db
      .prepare('UPDATE ocean_coding_approval_claims SET invocation_key=?')
      .run(
        JSON.stringify([
          'ws',
          'other',
          'room',
          'dev',
          binding.runId,
          binding.attemptId,
          binding.invocationId,
        ]),
      );
    f.db
      .prepare('UPDATE tool_invocations_v2 SET fingerprint=?,outcome=?')
      .run(hash({ ...a, binding, status: 'allowed' }), 'failed');
    expect(f.holds()).toContainEqual(expect.objectContaining({ kind: 'claim', scope: 'global' }));
    if (present) {
      f.db.exec("UPDATE tool_invocations_v2 SET outcome='completed'");
      expect(f.holds()).toEqual([]);
    }
  },
);
