import { expect, it } from 'vitest';
import {
  ConversationService,
  RoomTaskPersistence,
  claimRoomDelivery,
  unconfiguredModelConnection,
} from '@runnets/application';
import { rebindFixture } from '../../application/test-fixtures/profile-rebind.test.js';
import { openSqliteStore } from './store.js';
import { createHash } from 'node:crypto';
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
    store.modelConnections.put(
      {
        ...unconfiguredModelConnection('fixture'),
        connectionId: 'cloud',
        intent: 'active',
        revision: 1,
        endpoint: 'https://fixture.invalid',
        defaultModelId: 'fixture',
      },
      null,
    );
    store.conversations.atomic((tx) =>
      tx.putModelBinding('dev', { connectionId: 'cloud', modelId: 'fixture' }),
    );
    const rootInput = {
      workspaceId: 'ws',
      roomId: 'room',
      requestId: 'old-root',
      text: 'old',
      initialBotIds: ['dev'],
      participants: [{ botId: 'dev', grantReferences: [] }],
      mandate: { projectId: null, codingTaskId: null, permissions: [] },
    };
    const taskDeps = {
      store: store.conversations,
      ownerId: 'old',
      clock: { now: () => new Date(0) },
      nextId: () => 'old-' + request++,
      sha256: (text: string) => createHash('sha256').update(text).digest('hex'),
    };
    const oldRoot = new RoomTaskPersistence(taskDeps).start(rootInput);
    if (!oldRoot.ok) throw Error('old root');
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
    expect(store.conversations.atomic((tx) => tx.roomTasks!.restored())).toBe(true);
    store.bindRoomHost(
      { ownerId: ready.preview.ownerId, epochId: ready.preview.epochId },
      { origin: f.origin, active: store.rebind.active() },
    );
    expect(store.conversations.atomic((tx) => tx.roomTasks!.restored())).toBe(false);
    const deps = {
      ...taskDeps,
      ownerId: ready.preview.ownerId,
      nextId: () => 'fresh-' + request++,
    };
    const service = new RoomTaskPersistence(deps),
      fresh = service.startHosted({ ...rootInput, requestId: 'fresh-root' });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw Error('fresh root');
    expect(
      store.conversations.atomic((tx) =>
        (() => {
          const root = tx.roomTasks!.task(fresh.value.rootId);
          return root?.kind === 'root' ? root.hostScope : null;
        })(),
      ),
    ).toEqual({ ownerId: ready.preview.ownerId, epochId: ready.preview.epochId });
    expect(service.startHosted(rootInput)).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(
      claimRoomDelivery(
        {
          ...deps,
          resolver: {
            resolve() {
              throw Error('old root must stay inert');
            },
          },
        },
        oldRoot.value.deliveries[0]!.deliveryId,
      ).kind,
    ).toBe('held');
    expect(
      store.conversations.atomic((tx) =>
        (() => {
          const root = tx.roomTasks!.task(oldRoot.value.rootId);
          return root?.kind === 'root' ? root.hostScope : undefined;
        })(),
      ),
    ).toBeNull();
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
