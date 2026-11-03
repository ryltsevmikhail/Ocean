import { expect, it } from 'vitest';
import type { ProfileRebindSelection } from '@runnets/domain';
import { rebindFixture } from '../test-fixtures/profile-rebind.test.js';

const foreign = 'f'.repeat(64);
const cases: readonly {
  readonly name: string;
  readonly mutate: (selection: ProfileRebindSelection) => ProfileRebindSelection;
  readonly code: string;
  readonly planRoot?: string;
}[] = [
  {
    name: 'wrong room',
    mutate: (s) => ({ ...s, roomId: 'foreign' }),
    code: 'rebind_scope_conflict',
  },
  {
    name: 'wrong source owner',
    mutate: (s) => ({ ...s, sourceOwnerId: 'foreign' }),
    code: 'rebind_scope_conflict',
  },
  {
    name: 'wrong profile',
    mutate: (s) => ({ ...s, profileId: foreign }),
    code: 'rebind_scope_conflict',
  },
  {
    name: 'wrong snapshot',
    mutate: (s) => ({ ...s, snapshotId: foreign }),
    code: 'rebind_scope_conflict',
  },
  {
    name: 'wrong task',
    mutate: (s) => ({ ...s, taskId: 'other-task' }),
    code: 'rebind_scope_conflict',
  },
  {
    name: 'wrong base commit',
    mutate: (s) => ({ ...s, baseCommit: 'c'.repeat(40) }),
    code: 'rebind_scope_conflict',
  },
  {
    name: 'wrong before tree',
    mutate: (s) => ({ ...s, treeHash: 'c'.repeat(64) }),
    code: 'rebind_project_changed',
  },
  {
    name: 'malformed tree hash',
    mutate: (s) => ({ ...s, treeHash: 'not-a-tree' }),
    code: 'invalid_input',
  },
  {
    name: 'wrong selected project',
    planRoot: '/different-witness-root',
    mutate: (s) => ({ ...s, projectRoot: '/somewhere-else' }),
    code: 'rebind_project_changed',
  },
  {
    name: 'old policy version',
    mutate: (s) => ({
      ...s,
      policy: { ...s.policy, version: 0 } as unknown as ProfileRebindSelection['policy'],
    }),
    code: 'invalid_input',
  },
  {
    name: 'old policy capabilities',
    mutate: (s) => ({
      ...s,
      policy: {
        ...s.policy,
        reviewCapabilities: ['project_read'],
      } as unknown as ProfileRebindSelection['policy'],
    }),
    code: 'invalid_input',
  },
];
it.each(cases)(
  'refuses $name before any decision, lease or materialization',
  async ({ mutate, code, planRoot }) => {
    const f = rebindFixture();
    if (planRoot) f.planRoot(planRoot);
    await expect(f.service!.preview(mutate(f.input))).rejects.toThrow(code);
    expect(f.rows.size).toBe(0);
    expect(f.effects()).toBe(0);
    expect(f.published()).toBe(false);
  },
);

it('refuses an existing unresolved global effect before preview', async () => {
  const f = rebindFixture();
  f.hold();
  await expect(f.service!.preview(f.input)).rejects.toThrow('rebind_effects_held');
  expect(f.rows.size).toBe(0);
  expect(f.effects()).toBe(0);
});

it('records an expired preview refused without any effect', async () => {
  const f = rebindFixture(),
    card = (await f.service!.preview(f.input))!;
  f.expire();
  const resolved = await f.owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  expect(resolved.status).toBe('expired');
  await f.service!.join();
  expect(f.service!.result(f.input)).toMatchObject({
    state: 'refused',
    reason: 'expired',
    projectLease: null,
    worktreeLease: null,
    result: null,
  });
  expect(f.effects()).toBe(0);
  expect(f.published()).toBe(false);
});

it('records a stale preview refused without any effect', async () => {
  const f = rebindFixture(),
    card = (await f.service!.preview(f.input))!;
  f.change();
  const resolved = await f.owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  expect(resolved.status).toBe('invalidated');
  await f.service!.join();
  expect(f.service!.result(f.input)).toMatchObject({
    state: 'refused',
    reason: 'invalidated',
    projectLease: null,
    worktreeLease: null,
    result: null,
  });
  expect(f.effects()).toBe(0);
  expect(f.published()).toBe(false);
});

it('does not let an old allowed approval or consumed claim execute again', async () => {
  const f = rebindFixture(),
    card = (await f.service!.preview(f.input))!;
  await f.owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  await f.service!.join();
  const ready = f.service!.result(f.input);
  expect(ready.state).toBe('ready');
  expect(f.effects()).toBe(1);
  // Re-presenting the member reference returns the settled card only; the resolved
  // approval and the consumed confirmation revision cannot start a second materialization.
  const reused = await f.service!.preview(f.input);
  expect(reused.status).toBe('allowed');
  await f.owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  await f.service!.join();
  expect(f.effects()).toBe(1);
  expect(f.service!.result(f.input)).toEqual(ready);
  // A distinct request cannot start a second epoch while the ready record blocks the head.
  await expect(f.service!.preview({ ...f.input, requestId: 'second-rebind' })).rejects.toThrow(
    'rebind_in_progress',
  );
  expect(f.effects()).toBe(1);
});
