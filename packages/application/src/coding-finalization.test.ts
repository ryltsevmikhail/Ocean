import { expect, it } from 'vitest';
import { digest, fixture, ref, until } from './coding-finalization-fakes.js';
it('denies without touching the task or the registry', async () => {
  const f = fixture();
  const card = await f.service.preview(f.selection, new AbortController().signal);
  expect(card.kind).toBe('task-finalization');
  await f.decisions.resolve(ref(card), card.bindingDigest, card.version, 'deny');
  await until(() => f.store.records.get('finalize-1')?.state === 'refused');
  expect(f.releases()).toBe(0);
  expect(f.store.tasks.get('task')?.status).toBe('reserved');
  expect(f.service.result(f.selection)).toMatchObject({
    state: 'refused',
    taskStatus: 'reserved',
  });
});
it('disables durably before the exact release and publishes the receipt', async () => {
  const f = fixture();
  const card = await f.service.preview(f.selection, new AbortController().signal);
  await f.decisions.resolve(ref(card), card.bindingDigest, card.version, 'allow-once');
  await until(() => f.store.records.get('finalize-1')?.state === 'finalized');
  expect(f.store.events).toEqual(['disable', 'release', 'publish']);
  expect(f.store.tasks.get('task')?.status).toBe('finalized');
  expect(f.releases()).toBe(1);
  const result = f.service.result(f.selection);
  expect(result).toMatchObject({ state: 'finalized', taskStatus: 'finalized' });
  expect(result.release.receipt?.tokenHash).toBe(digest('lease-token'));
  expect(result.retained).toMatchObject({
    projectRoot: '/project',
    worktreeRoot: '/project/wt',
    changesets: ['a'.repeat(64)],
    reviews: ['review-1'],
    evidence: ['b'.repeat(64)],
  });
});
it('refuses wrong owner, room, holds, second operation and restored profiles', async () => {
  const wrong = fixture({ ownerId: 'someone-else' });
  await expect(
    wrong.service.preview(wrong.selection, new AbortController().signal),
  ).rejects.toThrow('finalization_scope_conflict');
  const f = fixture();
  await expect(
    f.service.preview({ ...f.selection, roomId: 'other-room' }, new AbortController().signal),
  ).rejects.toThrow('finalization_scope_conflict');
  f.store.holds = [{ id: 'effect', kind: 'command', outcome: 'uncertain', scope: 'global' }];
  await expect(f.service.preview(f.selection, new AbortController().signal)).rejects.toThrow(
    'finalization_effects_held',
  );
  f.store.holds = [{ id: 'turn', kind: 'provider', outcome: 'dispatching', scope: 'task' }];
  await expect(f.service.preview(f.selection, new AbortController().signal)).rejects.toThrow(
    'finalization_worker_active',
  );
  f.store.holds = [];
  await f.service.preview(f.selection, new AbortController().signal);
  await expect(
    f.service.preview({ ...f.selection, requestId: 'finalize-2' }, new AbortController().signal),
  ).rejects.toThrow('finalization_in_progress');
  const restored = fixture({ restored: true });
  await expect(
    restored.service.preview(restored.selection, new AbortController().signal),
  ).rejects.toThrow('finalization_restricted');
});
it('invalidates an allowed decision when the task changed while awaiting it', async () => {
  const f = fixture();
  const card = await f.service.preview(f.selection, new AbortController().signal);
  const task = f.store.tasks.get('task')!;
  f.store.tasks.set('task', { ...task, worktreeRoot: '/project/other' });
  expect(
    await f.decisions.resolve(ref(card), card.bindingDigest, card.version, 'allow-once'),
  ).toMatchObject({
    status: 'invalidated',
  });
  await until(() => f.store.records.get('finalize-1')?.state === 'refused');
  expect(f.releases()).toBe(0);
  expect(f.store.tasks.get('task')?.status).toBe('reserved');
});
