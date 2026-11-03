import { afterEach, expect, it } from 'vitest';
import { claimFixture } from '../test-fixtures/finalization-claims.js';
const fixtures: ReturnType<typeof claimFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const setup = () => {
  const f = claimFixture();
  fixtures.push(f);
  return f;
};
it.each([
  'missing',
  'hash',
  'id',
  'task_id',
  'binding',
  'invocationHash',
  'beforeTreeHash',
  'cleanupConfirmed',
  'reason',
  'exitCode',
  'presetId',
  'extra shape',
  'result contradiction',
])('keeps test claims held on %s evidence', async (mode) => {
  const f = setup();
  const operation = await f.dispatch('test');
  if (mode === 'missing') f.db.exec('DELETE FROM ocean_coding_test_evidence');
  else if (['hash', 'id', 'task_id'].includes(mode))
    f.db.prepare('UPDATE ocean_coding_test_evidence SET ' + mode + '=?').run('wrong');
  else
    f.changeEvidence(operation.id, (body) => {
      if (mode === 'binding') body['binding'] = { ...operation.binding, invocationId: 'other' };
      else if (mode === 'cleanupConfirmed') body[mode] = false;
      else if (mode === 'result contradiction') body['exitCode'] = 3;
      else if (mode === 'exitCode') body[mode] = '0';
      else if (mode === 'extra shape') body['unknown'] = true;
      else body[mode] = 'wrong';
    });
  const before = f.rows();
  expect(f.holds().length).toBeGreaterThan(0);
  expect(f.rows()).toEqual(before);
});
it.each(['afterTreeHash', 'dependenciesUnchanged', 'reason'] as const)(
  'accepts cleaned failed evidence with historical %s, preserving the failure',
  async (field) => {
    const f = setup();
    const operation = await f.dispatch('test', 3);
    f.changeEvidence(operation.id, (body) => {
      if (field === 'afterTreeHash') body[field] = '7'.repeat(64);
      else if (field === 'dependenciesUnchanged') body[field] = false;
      else body[field] = 'timeout';
    });
    const before = f.rows();
    expect(f.holds()).toEqual([]);
    expect(f.rows()).toEqual(before);
  },
);
it('does not confuse truncation with worker liveness or with the journal success predicate', async () => {
  const f = setup();
  const operation = await f.dispatch('test');
  f.changeEvidence(operation.id, (body) => {
    body['truncated'] = true;
  });
  expect(f.holds()).toEqual([]);
});
it('holds a write with contradictory test evidence instead of interpreting it as a test', async () => {
  const f = setup();
  const write = await f.dispatch('write');
  const test = await f.dispatch('test');
  f.db.prepare('UPDATE ocean_coding_test_evidence SET id=? WHERE id=?').run(write.id, test.id);
  expect(f.holds()).toContainEqual(expect.objectContaining({ kind: 'claim' }));
});
it.each(['started', 'uncertain', 'not_started'] as const)(
  'never upgrades cleanup evidence over a %s test journal',
  async (outcome) => {
    const f = setup();
    await f.dispatch('test');
    f.db.prepare('UPDATE tool_invocations_v2 SET outcome=?').run(outcome);
    expect(f.holds().length).toBeGreaterThan(0);
  },
);
