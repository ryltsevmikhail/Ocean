import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileRebindRecord } from '@runnets/domain';
import { openSqliteStore } from './store.js';
import { rebindFixture } from '../../application/test-fixtures/profile-rebind.test.js';
const digest = (preview: unknown) =>
  createHash('sha256').update(JSON.stringify(preview)).digest('hex');
it('retains consumed rebind intent as held across two reopenings without publishing authority', async () => {
  const f = rebindFixture();
  await f.service.preview(f.input);
  const preview = f.rows.get(f.input.requestId)!;
  await f.service.close();
  const root = mkdtempSync(join(tmpdir(), 'rebind-store-')),
    path = join(root, 'runtime.sqlite');
  let store = openSqliteStore({ path });
  try {
    store.restoration.install(f.origin);
    expect(store.rebind?.atomic((tx) => tx.save(preview, null))).toBe(true);
    const confirmed = { ...preview, revision: 2, state: 'confirmed' as const };
    expect(store.rebind.atomic((tx) => tx.save(confirmed, 1))).toBe(true);
    expect(store.rebind.atomic((tx) => tx.save(confirmed, 1))).toBe(false);
    store.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      store = openSqliteStore({ path });
      store.rebind.recover();
      expect(store.rebind.atomic((tx) => tx.record(preview.requestId))).toMatchObject({
        state: 'held',
        revision: 3,
        reason: 'rebind_outcome_unknown',
        result: null,
        projectLease: null,
        worktreeLease: null,
      });
      expect(store.rebind.atomic((tx) => tx.busy())).toBe(true);
      store.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('cannot change preview scope, skip confirmation or reuse a consumed SQLite revision', async () => {
  const f = rebindFixture();
  await f.service.preview(f.input);
  const record = f.rows.get(f.input.requestId)!;
  await f.service.close();
  const store = openSqliteStore({ path: ':memory:' });
  try {
    store.restoration.install(f.origin);
    expect(store.rebind?.atomic((tx) => tx.save(record, null))).toBe(true);
    expect(() =>
      store.rebind.atomic((tx) =>
        tx.save(
          {
            ...record,
            revision: 2,
            preview: {
              ...record.preview,
              selection: { ...record.preview.selection, roomId: 'foreign' },
            },
          },
          1,
        ),
      ),
    ).toThrow('immutable_rebind');
    expect(() =>
      store.rebind.atomic((tx) => tx.save({ ...record, revision: 2, state: 'ready' }, 1)),
    ).toThrow('invalid_rebind_transition');
    expect(store.rebind.atomic((tx) => tx.record(record.requestId))).toEqual(record);
  } finally {
    store.close();
  }
});
it('durably records a known pre-effect refusal after confirmation but never with a lease', async () => {
  const f = rebindFixture();
  await f.service.preview(f.input);
  const record = f.rows.get(f.input.requestId)!;
  await f.service.close();
  const store = openSqliteStore({ path: ':memory:' });
  try {
    store.restoration.install(f.origin);
    expect(store.rebind.atomic((tx) => tx.save(record, null))).toBe(true);
    expect(
      store.rebind.atomic((tx) => tx.save({ ...record, revision: 2, state: 'confirmed' }, 1)),
    ).toBe(true);
    const refused: ProfileRebindRecord = {
      ...record,
      revision: 3,
      state: 'refused',
      reason: 'project_busy',
    };
    expect(store.rebind.atomic((tx) => tx.save(refused, 2))).toBe(true);
    expect(store.rebind.atomic((tx) => tx.record(record.requestId))).toMatchObject({
      state: 'refused',
      reason: 'project_busy',
      projectLease: null,
      worktreeLease: null,
      result: null,
    });
    expect(store.rebind.atomic((tx) => tx.busy())).toBe(false);
    // A refusal cannot hide an apparent binding or be rewritten into preparing.
    expect(() =>
      store.rebind.atomic((tx) =>
        tx.save(
          {
            ...refused,
            revision: 4,
            projectLease: {
              ownerId: 'owner',
              projectRoot: '/new',
              taskId: 'task',
              requestId: 'request',
              binding: 'binding',
              kind: 'coding',
              token: 'token',
            },
          },
          3,
        ),
      ),
    ).toThrow('invalid_rebind_transition');
    expect(() =>
      store.rebind.atomic((tx) => tx.save({ ...refused, revision: 4, state: 'held' }, 3)),
    ).toThrow('invalid_rebind_transition');
  } finally {
    store.close();
  }
});

it('refuses an old, denied or foreign approval and a foreign origin before publication', async () => {
  const f = rebindFixture(),
    card = await f.service.preview(f.input);
  const preview = f.rows.get(f.input.requestId)!;
  await f.owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  await f.service.join();
  const ready = f.service.result(f.input),
    result = ready.result!;
  await f.service.close();
  const deniedFixture = rebindFixture(),
    deniedCard = await deniedFixture.service.preview(deniedFixture.input);
  await deniedFixture.owner.resolve(
    deniedCard,
    deniedCard.bindingDigest,
    deniedCard.version,
    'deny',
  );
  await deniedFixture.service.join();
  await deniedFixture.service.close();
  const store = openSqliteStore({ path: ':memory:' });
  try {
    store.restoration.install(f.origin);
    const confirmed = { ...preview, revision: 2, state: 'confirmed' as const };
    const preparing: ProfileRebindRecord = {
      ...confirmed,
      revision: 3,
      state: 'preparing',
      projectLease: ready.projectLease,
      worktreeLease: ready.worktreeLease,
    };
    store.rebind.atomic((tx) => {
      tx.save(preview, null);
      tx.save(confirmed, 1);
      tx.save(preparing, 2);
    });
    store.ownerDecisions.insert(
      deniedCard,
      JSON.stringify(deniedFixture.rows.get('rebind')!.preview),
    );
    expect(store.ownerDecisions.settle(deniedCard, 'denied')).toBe(true);
    // A denied/old owner decision can never publish the freshly prepared binding.
    expect(() =>
      store.rebind.atomic((tx) => tx.publish({ ...ready, revision: 4 }, result)),
    ).toThrow('rebind_confirmation_inactive');
    // A record whose durable origin is not the installed head is immutable, even when
    // its self-consistent payload digest is recomputed by the caller.
    const foreignPreview = {
      ...preview.preview,
      selection: { ...preview.preview.selection, requestId: 'foreign-rebind' },
      origin: { ...preview.preview.origin, profileId: 'f'.repeat(64) },
    };
    expect(() =>
      store.rebind.atomic((tx) =>
        tx.save(
          {
            ...preview,
            requestId: 'foreign-rebind',
            bindingDigest: digest(foreignPreview),
            preview: foreignPreview,
          },
          null,
        ),
      ),
    ).toThrow('immutable_rebind');
    // A fresh record cannot start in preparing, nor create a preparing state without
    // both durable leases, so a refused/denied operation cannot manufacture one.
    const freshPreview = {
      ...preview.preview,
      selection: { ...preview.preview.selection, requestId: 'fresh-rebind' },
    };
    expect(() =>
      store.rebind.atomic((tx) =>
        tx.save(
          {
            ...preview,
            requestId: 'fresh-rebind',
            revision: 1,
            state: 'preparing',
            bindingDigest: digest(freshPreview),
            preview: freshPreview,
          },
          null,
        ),
      ),
    ).toThrow('invalid_rebind_transition');
  } finally {
    store.close();
  }
});
