import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomModelPolicyService } from '@runnets/application';
import { policyFixture } from '../../application/test-fixtures/room-model-policy.js';
import { openSqliteStore } from './index.js';
import { initializeSchema } from './schema.js';
import { SqliteConversationStore } from './conversations.js';

const close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0).reverse()) cleanup();
});
it('persists policy and receipt across reopen, rolls both back on SQL receipt failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  close.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.sqlite');
  const db = openSqliteStore({ path });
  close.push(() => db.close());
  const raw = new DatabaseSync(path);
  close.push(() => raw.close());
  const f = policyFixture(db.conversations, db.modelConnections);
  expect(f.store.atomic((tx) => tx.roomModelPolicy(f.room.id))).toEqual({
    roomId: f.room.id,
    cloudTransfer: 'allow',
    revision: 1,
  });
  raw.exec(
    "CREATE TRIGGER reject_policy BEFORE INSERT ON ocean_receipts BEGIN SELECT RAISE(ABORT,'receipt rejected'); END",
  );
  expect(() => f.policy.set(f.input)).toThrow('receipt rejected');
  expect(f.store.atomic((tx) => tx.roomModelPolicy(f.room.id)?.revision)).toBe(1);
  raw.exec('DROP TRIGGER reject_policy');
  const result = f.policy.set(f.input);
  expect(result.ok).toBe(true);
  db.close();
  const reopened = openSqliteStore({ path });
  close.push(() => reopened.close());
  const policy = new RoomModelPolicyService({
    store: reopened.conversations,
    connections: {
      read: () => {
        throw Error('no reads on replay');
      },
    },
  });
  expect(policy.set(f.input)).toEqual(result);
  expect(reopened.conversations.atomic((tx) => tx.roomModelPolicy(f.room.id))).toEqual(
    result.ok ? result.value : null,
  );
});
it('migrates schema21 existing rooms to allow once and refuses missing policy thereafter', () => {
  const db = new DatabaseSync(':memory:');
  close.push(() => db.close());
  initializeSchema(db);
  const store = new SqliteConversationStore(db);
  const connections = { read: () => null };
  // Seed through SQL to keep this migration fixture independent of provider metadata.
  db.exec(
    "INSERT INTO ocean_workspace VALUES(1,'w','/project'); INSERT INTO ocean_bots VALUES('b','w','dev','Dev','role','deepseek','one',1); INSERT INTO ocean_rooms VALUES('r','w','direct','b',NULL); INSERT INTO ocean_members VALUES('w','r','b'); DROP TABLE ocean_room_model_policies; UPDATE meta SET value='21' WHERE key='schema_version'",
  );
  initializeSchema(db);
  expect(store.atomic((tx) => tx.roomModelPolicy('r'))).toEqual({
    roomId: 'r',
    cloudTransfer: 'allow',
    revision: 1,
  });
  db.exec("DELETE FROM ocean_room_model_policies WHERE room_id='r'");
  initializeSchema(db);
  expect(
    new RoomModelPolicyService({ store, connections }).set({
      workspaceId: 'w',
      roomId: 'r',
      requestId: 'deny',
      expectedRevision: 1,
      cloudTransfer: 'deny',
    }),
  ).toMatchObject({ ok: false, error: { code: 'model_policy_unavailable' } });
});

it('preserves schema21 doctor/backup without migrating the original or copy', async () => {
  const { inspectDatabase, snapshotDatabase } = await import('./maintenance.js');
  const dir = mkdtempSync(join(tmpdir(), 'policy-backup-'));
  close.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.sqlite');
  const current = openSqliteStore({ path });
  current.close();
  const raw = new DatabaseSync(path);
  close.push(() => raw.close());
  raw.exec(
    "DROP TABLE ocean_room_model_policies; UPDATE meta SET value='21' WHERE key='schema_version'",
  );
  expect(inspectDatabase(path)).toMatchObject({ status: 'ok', summary: { schema: 21 } });
  const copy = join(dir, 'copy.sqlite');
  await expect(snapshotDatabase(path, copy)).resolves.toMatchObject({ schema: 21 });
  const copied = new DatabaseSync(copy);
  close.push(() => copied.close());
  for (const db of [raw, copied]) {
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '21',
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_room_model_policies'").get(),
    ).toBeUndefined();
  }
});

it('rolls back schema22 table, backfill and version when publication fails', () => {
  const db = new DatabaseSync(':memory:');
  close.push(() => db.close());
  initializeSchema(db);
  db.exec(
    "DROP TABLE ocean_room_model_policies; UPDATE meta SET value='21' WHERE key='schema_version'; CREATE TRIGGER stop_policy BEFORE UPDATE ON meta WHEN NEW.key='schema_version' AND NEW.value='23' BEGIN SELECT RAISE(ABORT,'publication failed'); END",
  );
  expect(() => initializeSchema(db)).toThrow('publication failed');
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '21',
  );
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_room_model_policies'").get(),
  ).toBeUndefined();
  db.exec('DROP TRIGGER stop_policy');
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '23',
  );
});
it('rejects malformed JSON policy receipts and invalid persisted policy scalars without coercion', () => {
  const db = new DatabaseSync(':memory:');
  close.push(() => db.close());
  initializeSchema(db);
  const store = new SqliteConversationStore(db);
  const receipt = db.prepare('INSERT INTO ocean_receipts VALUES(?,?,?)');
  for (const [id, reply] of [
    ['array-kind', { kind: ['room_model_policy'], data: {} }],
    [
      'array-value',
      { kind: 'room_model_policy', data: { roomId: 'r', cloudTransfer: ['allow'], revision: 1 } },
    ],
    [
      'string-revision',
      { kind: 'room_model_policy', data: { roomId: 'r', cloudTransfer: 'allow', revision: '1' } },
    ],
  ] as const) {
    receipt.run(id, 'binding', JSON.stringify(reply));
    expect(() => store.atomic((tx) => tx.receipt(id))).toThrow('Invalid conversation receipt');
  }
  db.exec(
    "INSERT INTO ocean_workspace VALUES(1,'w','/project'); INSERT INTO ocean_bots VALUES('b','w','dev','Dev','role','deepseek','one',1); INSERT INTO ocean_rooms VALUES('r','w','direct','b',NULL); INSERT INTO ocean_members VALUES('w','r','b'); PRAGMA ignore_check_constraints=ON; INSERT INTO ocean_room_model_policies VALUES('r','[\"allow\"]',1)",
  );
  expect(store.atomic((tx) => tx.roomModelPolicy('r'))).toBeNull();
});
