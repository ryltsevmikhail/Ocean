import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore, ownSqliteRuntime } from './index.js';
import { inspectDatabase, snapshotDatabase } from './maintenance.js';
import { omitModelConnectionSchema } from '../test-fixtures/model-schema.js';
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
it('admits the unreleased intermediate schemas 15 and 16 to doctor and backup', async () => {
  const { root, path } = setup();
  const db = new DatabaseSync(path);
  try {
    for (const version of ['15', '16']) {
      db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(version);
      expect(inspectDatabase(path), version).toMatchObject({ status: 'ok' });
    }
    db.prepare("UPDATE meta SET value='15' WHERE key='schema_version'").run();
  } finally {
    db.close();
  }
  await expect(snapshotDatabase(path, join(root, 'schema15.sqlite'))).resolves.toMatchObject({
    schema: 15,
  });
});
it('keeps genuine schema19 doctor and snapshot available without migrating the source or copy', async () => {
  const { root, path } = setup();
  const db = new DatabaseSync(path);
  omitModelConnectionSchema(db);
  db.prepare("UPDATE meta SET value='19' WHERE key='schema_version'").run();
  db.close();
  expect(inspectDatabase(path)).toMatchObject({ status: 'ok', summary: { schema: 19 } });
  const copyPath = join(root, 'schema19.sqlite');
  await expect(snapshotDatabase(path, copyPath)).resolves.toMatchObject({ schema: 19 });
  for (const file of [path, copyPath]) {
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      expect(
        check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
      ).toBe('19');
      expect(
        check.prepare("SELECT name FROM sqlite_master WHERE name='ocean_model_connections'").get(),
      ).toBeUndefined();
    } finally {
      check.close();
    }
  }
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

it.each(['before_begin', 'after_schema'])(
  'full doctor reads schema, ownership and summary in one snapshot during %s owner admission',
  (when) => {
    const { path } = setup();
    ownSqliteRuntime(path)();
    const writer = new DatabaseSync(path);
    let claimed = false;
    const claim = () => {
      if (claimed) return;
      claimed = true;
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare('INSERT INTO runtime_owner_v1 VALUES(1,?,?)').run('racing-owner', process.pid);
      writer.prepare("INSERT INTO tool_invocations_v1 VALUES('late','synthetic','started')").run();
      writer.exec('COMMIT');
    };
    const exec = DatabaseSync.prototype.exec,
      prepare = DatabaseSync.prototype.prepare;
    const begin = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (this !== writer && sql === 'BEGIN' && when === 'before_begin') claim();
      return exec.call(this, sql);
    });
    const read = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (this !== writer && when === 'after_schema' && sql.includes("name='runtime_owner_v1'"))
        claim();
      return prepare.call(this, sql);
    });
    try {
      const inspection = inspectDatabase(path);
      expect(claimed).toBe(true);
      expect(inspection).toMatchObject(
        when === 'before_begin'
          ? { status: 'owner_busy' }
          : { status: 'ok', summary: { pendingEffects: 0 } },
      );
      expect(writer.prepare('SELECT owner FROM runtime_owner_v1').get()?.['owner']).toBe(
        'racing-owner',
      );
    } finally {
      read.mockRestore();
      begin.mockRestore();
      writer.close();
    }
  },
);

it('does not report a bound zero-coding Desktop profile as a SQLite-only backup', async () => {
  const { root, path } = setup();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO meta(key,value) VALUES('desktop_assets_binding',?)").run(
    JSON.stringify({ root: '/inert/test/source' }),
  );
  db.close();
  await expect(snapshotDatabase(path, join(root, 'copy.sqlite'))).rejects.toThrow(
    'desktop_assets_unavailable',
  );
});
it('refuses SQLite-only backup of an admitted enrollment with unknown filesystem outcome', async () => {
  const { root, path } = setup();
  const db = new DatabaseSync(path);
  db.prepare(
    "INSERT INTO ocean_desktop_operations VALUES('enrollment','/synthetic/userData','started',NULL)",
  ).run();
  db.close();
  await expect(snapshotDatabase(path, join(root, 'unknown-copy.sqlite'))).rejects.toThrow(
    'desktop_assets_unavailable',
  );
});
