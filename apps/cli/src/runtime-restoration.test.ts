import { expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { bindRuntimeRoomHost } from './runtime-restoration.js';
it('binds only the retained verified snapshot without rereading a different baseline', () => {
  const store = openSqliteStore({ path: ':memory:' });
  const verified = { origin: store.restoration.origin(), active: store.rebind.active() };
  try {
    const origin = vi.spyOn(store.restoration, 'origin').mockImplementation(() => {
      throw Error('must not rebaseline');
    });
    const active = vi.spyOn(store.rebind, 'active').mockImplementation(() => {
      throw Error('must not rebaseline');
    });
    expect(() => bindRuntimeRoomHost(store, 'owner', true, verified)).not.toThrow();
    expect(origin).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
    expect(store.conversations.atomic((tx) => tx.roomTasks!.hostScope())).toEqual({
      ownerId: 'owner',
      epochId: null,
    });
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});
