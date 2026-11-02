import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore, ownSqliteRuntime } from './index.js';
import { inspectDatabase, snapshotDatabase } from './maintenance.js';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-maint-'));
  roots.push(root);
  const path = join(root, 'runtime.sqlite');
  const store = openSqliteStore({ path });
  store.close();
  return { root, path };
}
it('doctor does not take ownership or migrate a database', () => {
  const { path } = setup();
  const release = ownSqliteRuntime(path);
  try {
    expect(inspectDatabase(path).status).toBe('owner_busy');
  } finally {
    release();
  }
  const db = new DatabaseSync(path);
  db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
  db.close();
  expect(inspectDatabase(path).status).toBe('unsupported_schema');
  const check = new DatabaseSync(path, { readOnly: true });
  expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe(
    '999',
  );
  check.close();
});
it('snapshots WAL with exclusive maintenance ownership and preserves unresolved claims', async () => {
  const { root, path } = setup();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.prepare("INSERT INTO tool_invocations_v1 VALUES ('old','shell','uncertain')").run();
  const release = ownSqliteRuntime(path);
  try {
    await expect(snapshotDatabase(path, join(root, 'blocked.sqlite'))).rejects.toThrow(
      'owner_busy',
    );
  } finally {
    release();
  }
  const summary = await snapshotDatabase(path, join(root, 'copy.sqlite'));
  expect(summary.pendingEffects).toBe(1);
  const copy = new DatabaseSync(join(root, 'copy.sqlite'), { readOnly: true });
  expect(copy.prepare('SELECT count(*) AS n FROM runtime_owner_v1').get()?.n).toBe(0);
  expect(copy.prepare('SELECT outcome FROM tool_invocations_v1').get()?.outcome).toBe('uncertain');
  copy.close();
  db.close();
});
