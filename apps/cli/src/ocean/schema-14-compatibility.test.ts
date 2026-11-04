import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@runnets/store-sqlite';
import { runOceanCommand, type OceanCommandOptions } from './command.js';

/**
 * RC1 (schema 14) compatibility regression.
 *
 * The installed RC1 profile and every backup it wrote are schema-14 stores. RC2's
 * schema bump to 15 must keep the maintenance allowlist open for 14, otherwise
 * `doctor`, `backup --to` and restoring an RC1-era format-2 backup are refused
 * (unsupported_schema / invalid_backup) exactly when the update path needs them.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function call(profile: string, args: string[], options: OceanCommandOptions = {}) {
  let raw = '';
  const output = new PassThrough();
  output.on('data', (b: Buffer) => {
    raw += b.toString();
  });
  const code = await runOceanCommand([...args, '--profile', profile, '--json'], {
    output,
    error: new PassThrough(),
    ...options,
  });
  return { code, reply: JSON.parse(raw) as Record<string, unknown> };
}
/** Recreate the exact accepted schema-14 shape RC1 ships: finalization tables, no provider rows. */
function downgradeToSchema14(profile: string): void {
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'));
  try {
    db.exec(`DROP TABLE IF EXISTS ocean_room_model_policies;
    DROP TABLE IF EXISTS ocean_bot_model_bindings;
    DROP TABLE IF EXISTS ocean_model_connection_receipts;
    DROP TABLE IF EXISTS ocean_model_connections;
    DROP TABLE IF EXISTS ocean_provider_receipts;
      DROP TABLE IF EXISTS ocean_provider_connections;
      UPDATE meta SET value='14' WHERE key='schema_version';`);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '14',
    );
  } finally {
    db.close();
  }
}
function schemaVersion(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']);
  } finally {
    db.close();
  }
}
async function rc1Profile(root: string): Promise<string> {
  const profile = join(root, 'profile');
  expect((await call(profile, ['init', '--workspace', root])).code).toBe(0);
  expect(
    (await call(profile, ['bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Role']))
      .code,
  ).toBe(0);
  expect((await call(profile, ['room', 'direct', '--bot', 'dev'])).code).toBe(0);
  downgradeToSchema14(profile);
  return profile;
}
it('doctors, backs up and restores an installed-RC1 schema-14 profile before upgrading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-schema14-'));
  roots.push(root);
  const profile = await rc1Profile(root);

  const doctor = await call(profile, ['doctor']);
  expect(doctor.code).toBe(0);
  const inspection = (doctor.reply['data'] as Record<string, unknown>)['database'] as Record<
    string,
    unknown
  >;
  expect(inspection['status']).toBe('ok');
  expect((inspection['summary'] as Record<string, unknown>)['schema']).toBe(14);

  const archive = join(root, 'backup');
  const backup = await call(profile, ['backup', '--to', archive]);
  expect(backup.code).toBe(0);
  const manifest = backup.reply['data'] as Record<string, unknown>;
  expect(manifest['format']).toBe(2);
  expect((manifest['summary'] as Record<string, unknown>)['schema']).toBe(14);
  expect(schemaVersion(join(archive, 'runtime.sqlite'))).toBe('14');

  // Restoring the RC1-era format-2 backup must be accepted, not `invalid_backup`.
  const restored = join(root, 'restored');
  expect((await call(restored, ['restore', '--from', archive])).code).toBe(0);
  // Restore installs its origin through the RC2 store, so the accepted copy is migrated to 15
  // with the RC1 data preserved; the archive itself stays byte-identical at schema 14.
  expect(schemaVersion(join(archive, 'runtime.sqlite'))).toBe('14');
  expect(schemaVersion(join(restored, 'runtime.sqlite'))).toBe(String(SCHEMA_VERSION));
  const restoredDoctor = await call(restored, ['doctor']);
  expect(restoredDoctor.code).toBe(0);
  expect((restoredDoctor.reply['data'] as Record<string, unknown>)['restored']).toBe(true);
  const migrated = new DatabaseSync(join(restored, 'runtime.sqlite'), { readOnly: true });
  try {
    expect(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ocean_provider_connections','ocean_provider_receipts')",
        )
        .all(),
    ).toHaveLength(2);
    expect(migrated.prepare('SELECT count(*) AS n FROM ocean_rooms').get()?.['n']).toBe(1);
  } finally {
    migrated.close();
  }
}, 60_000);
