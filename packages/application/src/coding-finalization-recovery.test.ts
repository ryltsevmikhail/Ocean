import { expect, it } from 'vitest';
import { CodingFinalizationService } from './coding-finalization.js';
import { RuntimeOwnerDecisions } from './owner-decisions.js';
import { digest, fixture, ref, until } from './coding-finalization-fakes.js';
it('keeps an unproven registry outcome held and never retries it', async () => {
  const f = fixture({ release: 'registry_missing' });
  const card = await f.service.preview(f.selection, new AbortController().signal);
  await f.decisions.resolve(ref(card), card.bindingDigest, card.version, 'allow-once');
  await until(() => f.store.records.get('finalize-1')?.state === 'uncertain');
  expect(f.releases()).toBe(1);
  expect(f.store.tasks.get('task')?.status).toBe('finalizing');
  expect(f.store.projectHeld('/project')).toBe(true);
  expect(f.service.result(f.selection)).toMatchObject({
    state: 'uncertain',
    taskStatus: 'finalizing',
    release: { state: 'unproven', outcome: 'registry_missing' },
  });
  // Opening the profile again inspects durable facts only: no second release.
  new CodingFinalizationService({
    store: f.store,
    leases: {
      acquire: () => {
        throw Error('unused');
      },
      owns: () => true,
      release: () => false,
      identity: () => ({ path: '/registry/leases.sqlite', schema: 'project_leases_v1' }),
      releaseExact: () => {
        throw Error('release must never be retried');
      },
      releaseReceipt: () => null,
    },
    owner: new RuntimeOwnerDecisions(f.owner, Date.now),
    clock: { now: () => new Date() },
    ownerId: 'owner',
    epochId: null,
    restored: false,
    nextId: () => 'id-3',
    digest,
  });
  expect(f.releases()).toBe(1);
  expect(f.store.records.get('finalize-1')).toMatchObject({
    state: 'uncertain',
    release: { state: 'unproven' },
  });
});
it('lets only one of two racing confirmed clients release once', async () => {
  const f = fixture();
  const card = await f.service.preview(f.selection, new AbortController().signal);
  const results = await Promise.all([
    f.decisions.resolve(ref(card), card.bindingDigest, card.version, 'allow-once'),
    f.decisions.resolve(ref(card), card.bindingDigest, card.version, 'allow-once'),
  ]);
  // The common decision is idempotent for the same card: both callers observe the
  // one winning settlement, while exactly one release effect runs.
  expect(results.every((result) => result.status === 'allowed')).toBe(true);
  await until(() => f.store.records.get('finalize-1')?.state === 'finalized');
  expect(f.releases()).toBe(1);
  expect(f.store.events.filter((event) => event === 'release')).toHaveLength(1);
});
