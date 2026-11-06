import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomTaskPersistence, claimRoomDelivery } from '@runnets/application';
import { openSqliteStore, inspectDatabase } from './index.js';
import { fixture, seed } from '../test-fixtures/room-slices-v28.js';
it('preserves genuine BASE28 named columns and never enrolls migrated or replayed roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-host-v28-')),
    path = join(dir, 'profile.sqlite');
  const old = new DatabaseSync(path);
  try {
    expect(fixture.base).toBe('79edcaa9132865e270f39329a98e2ba0d11e5082');
    seed(old);
    old.close();
    expect(inspectDatabase(path)).toMatchObject({ status: 'ok', summary: { schema: 28 } });
    const store = openSqliteStore({ path }),
      read = new DatabaseSync(path);
    try {
      for (const [table, rows] of Object.entries(fixture.rows))
        if (table !== 'meta' && rows.length) {
          const keys = Object.keys(rows[0]!);
          expect(read.prepare(`SELECT ${keys.join(',')} FROM ${table}`).all(), table).toEqual(rows);
        }
      expect(
        read.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
      ).toBe('29');
      expect(
        read
          .prepare('SELECT host_scope FROM ocean_room_tasks')
          .all()
          .every((r) => r['host_scope'] === null),
      ).toBe(true);
      store.bindRoomHost({ ownerId: 'owner', epochId: null }, { origin: null, active: null });
      const deps = {
        store: store.conversations,
        ownerId: 'owner',
        sha256: (s: string) => createHash('sha256').update(s).digest('hex'),
        clock: {
          now() {
            throw Error('replay clock');
          },
        },
        nextId() {
          throw Error('replay allocation');
        },
      };
      const service = new RoomTaskPersistence(deps);
      const receipt = service.startHosted({
        workspaceId: 'ws_fixture',
        roomId: 'room',
        requestId: 'start',
        text: 'work',
        initialBotIds: ['a', 'b'],
        participants: ['a', 'b', 'c'].map((botId) => ({ botId, grantReferences: [] })),
        mandate: { projectId: null, codingTaskId: null, permissions: [] },
      });
      expect(receipt).toMatchObject({
        ok: true,
        value: {
          rootId: 'd_1',
          messageId: 'd_2',
          deliveries: [
            { taskId: 'd_3', deliveryId: 'd_4' },
            { taskId: 'd_5', deliveryId: 'd_6' },
          ],
        },
      });
      expect(
        read.prepare('SELECT host_scope FROM ocean_room_tasks WHERE id=?').get('d_1')?.[
          'host_scope'
        ],
      ).toBeNull();
      expect(
        claimRoomDelivery(
          {
            ...deps,
            clock: { now: () => new Date('2026-11-06') },
            resolver: {
              resolve() {
                throw Error('inert resolver');
              },
            },
          },
          'd_6',
        ).kind,
      ).toBe('held');
      expect(read.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      read.close();
      store.close();
    }
  } finally {
    if (old.isOpen) old.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
