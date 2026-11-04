import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { unconfiguredModelConnection } from '@runnets/application';
import type { ProfileBackupManifest, RestoreOrigin } from '@runnets/domain';
import { initializeSchema } from './schema.js';
import { restoreOriginStore } from './restore-origin.js';
import { SqliteModelConnections } from './model-connection-storage.js';

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const manifest: Extract<ProfileBackupManifest, { format: 2 }> = {
  format: 2,
  createdAt: '2026-11-04T00:00:00Z',
  cli: 'fixture',
  node: 'fixture',
  sha256: 'a'.repeat(64),
  bytes: 4096,
  summary: {
    schema: 20,
    rooms: 0,
    messages: 0,
    positions: [],
    pendingEffects: 0,
    unfinishedRuns: 0,
    heldRooms: 0,
  },
  assets: {
    catalog: 'a'.repeat(64),
    codingInventory: 'b'.repeat(64),
    desktopInventory: 'c'.repeat(64),
    worktrees: 'd'.repeat(64),
    recovery: 'e'.repeat(64),
    dependencies: 'f'.repeat(64),
    desktop: null,
  },
};
const origin: RestoreOrigin = {
  version: 1,
  snapshotId: hash(JSON.stringify(manifest)),
  manifest,
  profileRoot: '/fixture/destination',
  profileId: hash('/fixture/destination'),
  sourceOwners: [],
};
function setup() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  opened.push(db);
  initializeSchema(db);
  const connections = new SqliteModelConnections(db);
  const active = {
    ...unconfiguredModelConnection('deepseek'),
    revision: 1,
    intent: 'active' as const,
    legacyEnvironment: false,
    configuredAfterRestore: true,
  };
  connections.put(active, 0);
  connections.put(
    {
      ...active,
      connectionId: 'another',
      intent: 'pending',
      pendingSecretChange: { action: 'replace', previousRef: 'old-ref', nextRef: 'next-ref' },
    },
    null,
  );
  return { db, connections, restoration: restoreOriginStore(db) };
}
it('resets every copied configuration flag inside origin installation without rewriting intent or receipts', () => {
  const { connections, restoration } = setup();
  const before = connections.list();
  restoration.install(origin);
  expect(restoration.origin()).toEqual(origin);
  expect(connections.list()).toEqual(
    before.map((record) => ({ ...record, configuredAfterRestore: false })),
  );
});
it('rolls back origin and all connection flag resets if any metadata update fails', () => {
  const { db, connections, restoration } = setup();
  const before = connections.list();
  db.exec(
    "CREATE TRIGGER reject_flag BEFORE UPDATE ON ocean_model_connections WHEN NEW.connection_id='legacy:deepseek' BEGIN SELECT RAISE(ABORT,'flag failure'); END",
  );
  expect(() => restoration.install(origin)).toThrow('flag failure');
  expect(restoration.origin()).toBeNull();
  expect(connections.list()).toEqual(before);
  expect(db.prepare('SELECT * FROM ocean_restore_origins').all()).toEqual([]);
  db.exec('DROP TRIGGER reject_flag');
  restoration.install(origin);
  expect(connections.list().every((row) => !row.configuredAfterRestore)).toBe(true);
});
