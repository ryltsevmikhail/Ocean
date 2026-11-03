import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from './store.js';
import { rebindFixture } from '../../application/test-fixtures/profile-rebind.test.js';
import { ConversationService } from '@runnets/application';
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
it('publishes a fresh epoch and successor atomically while preserving the original task and decision', async () => {
  const f = rebindFixture(),
    card = await f.service.preview(f.input);
  const preview = f.rows.get(f.input.requestId)!;
  await f.owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  await f.service.join();
  const ready = f.service.result(f.input),
    result = ready.result!;
  const store = openSqliteStore({ path: ':memory:' });
  try {
    let index = 0;
    const c = new ConversationService({
      store: store.conversations,
      clock: { now: () => new Date(0) },
      nextId: () => ['dev', 'reviewer', 'room', 'review'][index++]!,
    });
    let request = 0;
    const command = (v: Record<string, unknown>) =>
      c.execute({ workspaceId: 'ws', requestId: 'setup-' + request++, ...v } as Parameters<
        typeof c.execute
      >[0]);
    expect(command({ type: 'BindWorkspace', root: '/old' }).ok).toBe(true);
    for (const handle of ['dev', 'reviewer'])
      expect(
        command({
          type: 'CreateBot',
          handle,
          name: handle,
          role: 'fixture',
          provider: 'fixture',
          model: 'fixture',
        }).ok,
      ).toBe(true);
    for (const botId of ['dev', 'reviewer'])
      expect(command({ type: 'OpenDirectRoom', botId }).ok).toBe(true);
    store.coding.atomic((tx) => tx.putTask(f.old));
    store.restoration.install(f.origin);
    store.ownerDecisions.insert(card, JSON.stringify(preview.preview));
    expect(store.ownerDecisions.settle(card, 'allowed')).toBe(true);
    store.rebind.atomic((tx) => {
      tx.save(preview, null);
      tx.save({ ...preview, state: 'confirmed', revision: 2 }, 1);
      tx.save({ ...ready, state: 'preparing', revision: 3, result: null }, 2);
    });
    expect(store.rebind.active?.() ?? null).toBeNull();
    expect(() =>
      store.rebind.atomic((tx) => tx.publish({ ...ready, revision: 4 }, result)),
    ).not.toThrow();
    expect(store.rebind.active()?.preview.ownerId).toBe(ready.preview.ownerId);
    expect(store.coding.atomic((tx) => tx.task(f.old.id))).toEqual(f.old);
    expect(store.coding.atomic((tx) => tx.task(result.task.id))).toEqual(result.task);
    expect(store.coding.atomic((tx) => tx.worktree(result.task.id))).toEqual(result.worktree);
    expect(store.coding.atomic((tx) => tx.workspaceRoot('ws'))).toBe('/new');
    expect(store.ownerDecisions.find(card)?.status).toBe('allowed');
    expect(() =>
      store.rebind.atomic((tx) => tx.publish({ ...ready, revision: 4 }, result)),
    ).toThrow();
  } finally {
    store.close();
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
