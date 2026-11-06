import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { initializeSchema, openDatabase, DEFAULT_BUSY_TIMEOUT_MS } from './schema.js';
import { SqliteToolJournal } from './tool-journal.js';
const ctx = { taskRunId: 'run', attemptId: 'at' };
it('upgrades existing journal rows transactionally, retains spent identities, resolutions and unscoped legacy holds on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-admission-')),
    path = join(dir, 'db');
  let db = new DatabaseSync(path);
  try {
    initializeSchema(db);
    const original = new SqliteToolJournal(db);
    expect(original.claimNow('resolved', 'tool', ctx, 'first')).toBe(true);
    original.settleNow('resolved', 'uncertain', ctx);
    original.resolveUncertainNow('resolved', ctx, 'tool', 'owner acknowledgement');
    expect(original.claimNow('pending', 'tool', ctx, 'next')).toBe(true);
    original.settleNow('pending', 'uncertain', ctx);
    db.exec(
      "INSERT INTO tool_invocations_v1 VALUES('v1','tool','uncertain'); ALTER TABLE tool_invocations_v2 DROP COLUMN admission; UPDATE meta SET value='24' WHERE key='schema_version';",
    );
    const history = () =>
      db
        .prepare(
          'SELECT id,tool,task_run_id,attempt_id,fingerprint,outcome FROM tool_invocations_v2 ORDER BY id',
        )
        .all();
    const before = history(),
      resolutions = db.prepare('SELECT * FROM tool_effect_resolutions_v1').all();
    db.exec(
      "CREATE TRIGGER stop_25 BEFORE UPDATE ON meta WHEN NEW.value='26' BEGIN SELECT RAISE(ABORT,'rollback25'); END",
    );
    expect(() => initializeSchema(db)).toThrow('rollback25');
    expect(
      db
        .prepare('PRAGMA table_info(tool_invocations_v2)')
        .all()
        .map((r) => r['name']),
    ).not.toContain('admission');
    expect(history()).toEqual(before);
    db.exec('DROP TRIGGER stop_25');
    db.close();
    db = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
    expect(history()).toEqual(before);
    expect(db.prepare('SELECT * FROM tool_effect_resolutions_v1').all()).toEqual(resolutions);
    const journal = new SqliteToolJournal(db);
    expect(journal.inspectPending().map((r) => r.id)).toEqual(['pending', 'v1']);
    expect(journal.claimNow('resolved', 'tool', ctx, 'repeat')).toBe(false);
    expect(journal.claimNow('fresh', 'tool', ctx, 'other')).toBe(false);
    initializeSchema(db);
    db.exec('ALTER TABLE tool_invocations_v2 DROP COLUMN admission');
    expect(() => initializeSchema(db)).toThrow(/missing tool admission/);
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('opens schema24 with no journal and initializes the column exactly once on first use', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    db.exec("UPDATE meta SET value='24' WHERE key='schema_version'");
    initializeSchema(db);
    expect(db.prepare('PRAGMA table_info(tool_invocations_v2)').all()).toEqual([]);
    new SqliteToolJournal(db);
    new SqliteToolJournal(db);
    expect(
      db
        .prepare('PRAGMA table_info(tool_invocations_v2)')
        .all()
        .filter((r) => r['name'] === 'admission'),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});
