import { expect, it } from 'vitest';
import { CodingChangesetService } from '@runnets/application';
import { setup, artifact } from '../test-fixtures/changeset-service.ts';
for (const kind of ['memory', 'sqlite'] as const) {
  it(kind + ' refuses restored, pending and revoked readiness after verification', async () => {
    const s = await setup(kind);
    await s.service.prepare(s.access, { confirm: async () => true });
    const restored = new CodingChangesetService({
      ...s.deps,
      restored: true,
      worktrees: s.port,
      snapshots: s.snapshots,
    });
    expect((await restored.prepared(s.access)).ok).toBe(false);
    await s.journal.claim('unknown', 'shell', { taskRunId: 'tr', attemptId: 'at' }, 'synthetic');
    expect((await s.service.prepared(s.access)).ok).toBe(false);
    const other = await setup(kind);
    await other.service.prepare(other.access, { confirm: async () => true });
    other.port.verify = async () => {
      other.store.atomic((tx) => tx.putTask({ ...tx.task('task')!, status: 'cancelled' }));
    };
    expect((await other.service.prepared(other.access)).ok).toBe(false);
    expect(other.counts().creates).toBe(1);
  });

  it(kind + ' proves prepared worktrees read-only and refuses unresolved state', async () => {
    const s = await setup(kind);
    expect(await s.service.prepared(s.access)).toEqual({ ok: true, value: null });
    expect(s.counts().creates).toBe(0);
    const prepared = await s.service.prepare(s.access, { confirm: async () => true });
    expect(await s.service.prepared(s.access)).toEqual(prepared);
    expect((await s.service.prepared({ ...s.access, roomId: 'foreign' })).ok).toBe(false);
    s.port.verify = async () => {
      throw Error('missing Git worktree');
    };
    expect((await s.service.prepared(s.access)).ok).toBe(false);
    const uncertain = await setup(kind);
    uncertain.setFail();
    await uncertain.service.prepare(uncertain.access, { confirm: async () => true });
    expect((await uncertain.service.prepared(uncertain.access)).ok).toBe(false);
    expect(s.counts().creates).toBe(1);
  });

  it(
    kind +
      ' persists one worktree and immutable complete changesets with scoped idempotent receipts',
    async () => {
      const s = await setup(kind);
      expect((await s.service.prepare(s.access, { confirm: async () => false })).ok).toBe(false);
      expect(s.counts().creates).toBe(0);
      expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(true);
      expect(
        (
          await s.service.prepare(s.access, {
            confirm: async () => {
              throw Error('no repeat');
            },
          })
        ).ok,
      ).toBe(true);
      expect(s.store.atomic((tx) => tx.task('task'))?.worktreeRoot).toBe('/worktrees/task');
      const first = await s.service.capture(s.access, 'capture');
      if (!first.ok) throw Error('snapshot');
      s.setContent('second');
      expect(await s.service.capture(s.access, 'capture')).toEqual(first);
      expect(s.counts()).toEqual({ creates: 1, captures: 1 });
      const next = await s.service.capture(s.access, 'next');
      expect(next.ok && next.value.hash !== first.value.hash).toBe(true);
      const review = { ...s.access, botId: s.review, capability: 'changeset_read' as const };
      expect(s.service.read(review, first.value.hash)).toEqual(first);
      expect(() =>
        s.store.atomic((tx) => tx.putChangeset({ ...first.value, diff: 'tampered' })),
      ).toThrow();
      expect((await s.service.prepare(review, { confirm: async () => true })).ok).toBe(false);
      expect((await s.service.capture(review, 'forbidden')).ok).toBe(false);
      expect(s.service.read({ ...review, roomId: 'foreign' }, first.value.hash).ok).toBe(false);
      await s.journal.claim('unknown', 'shell', { taskRunId: 'tr', attemptId: 'at' }, 'synthetic');
      expect(s.service.read(review, first.value.hash)).toEqual(first);
      expect((await s.service.capture(s.access, 'blocked')).ok).toBe(false);
      expect(await s.service.capture(s.access, 'capture')).toEqual(first);
    },
  );
  it(
    kind +
      ' never repeats unknown worktree effects or releases a bound worktree through stage1 cancel',
    async () => {
      const s = await setup(kind);
      s.setFail();
      expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(false);
      expect(s.store.atomic((tx) => tx.worktree('task'))?.state).toBe('uncertain');
      expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(false);
      expect(s.counts().creates).toBe(1);
      expect(await s.coding.cancel('ws', 'task', { confirm: async () => true })).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
    },
  );
  it(kind + ' serializes concurrent preparation of the same task', async () => {
    const s = await setup(kind);
    const result = await Promise.all([
      s.service.prepare(s.access, { confirm: async () => true }),
      s.service.prepare(s.access, { confirm: async () => true }),
    ]);
    expect(result.filter((r) => r.ok)).toHaveLength(1);
    expect(s.counts().creates).toBe(1);
  });
}

for (const kind of ['memory', 'sqlite'] as const)
  it(kind + ' capture receipt failure rolls back the entire artifact transaction', async () => {
    const s = await setup(kind);
    await s.service.prepare(s.access, { confirm: async () => true });
    const failing = new CodingChangesetService({
      ...s.deps,
      store: {
        projectHeld: (root) => s.store.projectHeld(root),
        atomic: (work) =>
          s.store.atomic((tx) => {
            const value = work(tx);
            if (tx.captureReceipt('bad')) throw Error('receipt failure');
            return value;
          }),
      },
      worktrees: s.port,
      snapshots: s.snapshots,
    });
    await expect(failing.capture(s.access, 'bad')).rejects.toThrow('receipt failure');
    expect(s.store.atomic((tx) => tx.captureReceipt('bad'))).toBeNull();
    expect(s.store.atomic((tx) => tx.changeset(artifact('task', 'first').hash))).toBeNull();
    expect((await s.service.capture(s.access, 'good')).ok).toBe(true);
  });

it('pending cancellation cannot release a task after worktree preparation wins the race', async () => {
  const s = await setup('sqlite');
  let approved: (value: boolean) => void = () => {};
  let reached: () => void = () => {};
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  const pending = s.coding.cancel('ws', 'task', {
    confirm: () =>
      new Promise<boolean>((r) => {
        approved = r;
        reached();
      }),
  });
  await entered;
  expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(true);
  approved(true);
  expect(await pending).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
  const task = s.store.atomic((tx) => tx.task('task'));
  expect(task?.status).toBe('reserved');
  expect(task && s.leases.owns(task.lease)).toBe(true);
});
