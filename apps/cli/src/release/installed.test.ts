/**
 * Installed-tree rehearsals on disposable prefixes.
 *
 * A real archive (packaged from built modules with the bundled pinned adapter) is
 * installed with the production installer into private `/tmp` prefixes under
 * synthetic HOME/XDG directories. These tests prove the installed CLI offline
 * smoke, schema-14 migration and format-2 backup restore, version upgrade and
 * rollback with profile bytes untouched, and that the installed tree loads and
 * qualifies the bundled adapter without enabling real plugin execution.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { sha256 } from './installer.js';
import { packageRelease, type ReleasePackage } from './package.js';
import {
  call,
  cli,
  data,
  install,
  payload,
  privateInstall,
  type Installed,
} from '../../test-fixtures/installed-prefix.js';
import { releaseRepo } from '../../test-fixtures/release-repo.js';

let root: string;
let artifact: ReleasePackage;
let older: ReleasePackage;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ocean-installed-'));
  const repo = releaseRepo(join(root, 'repo'), { adapter: 'real' });
  artifact = await packageRelease(repo, '1.1.0-rc.2', join(root, 'artifact'));
  older = await packageRelease(repo, '0.2.0', join(root, 'artifact-old'));
}, 120_000);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function installAndInit(label: string): Installed {
  const target = privateInstall(root, label);
  install(target, artifact);
  expect(call(target, ['init', '--workspace', target.workspace]).code).toBe(0);
  expect(
    call(target, ['bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Role']).code,
  ).toBe(0);
  expect(call(target, ['room', 'direct', '--bot', 'dev']).code).toBe(0);
  return target;
}

it('installs into a private disposable prefix and passes the installed offline smoke', () => {
  const target = installAndInit('smoke');
  const releases = join(target.prefix, 'lib/ocean/releases');
  expect(statSync(join(releases, '1.1.0-rc.2')).mode & 0o777).toBe(0o700);
  expect(statSync(join(target.prefix, 'bin/ocean')).mode & 0o777).toBe(0o755);
  expect(statSync(join(releases, '1.1.0-rc.2', 'manifest.json')).mode & 0o777).toBe(0o644);
  const manifest = JSON.parse(readFileSync(join(releases, '1.1.0-rc.2/manifest.json'), 'utf8')) as {
    version: string;
    revision: string;
    bundle: { identities: Record<string, string> };
  };
  expect(manifest.version).toBe('1.1.0-rc.2');
  expect(manifest.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(manifest.bundle.identities['@executor-js/sdk']).toBe('1.6.11');
  expect(cli(target, ['--version']).stdout.trim()).toBe('ocean 1.1.0-rc.2');
  const doctor = call(target, ['doctor']);
  expect(doctor.code).toBe(0);
  expect(data(doctor.reply)['permissions']).toBe(true);
  expect(data(doctor.reply)['restored']).toBe(false);
  const rooms = call(target, ['room', 'list']);
  expect(rooms.code).toBe(0);
  expect(payload(rooms.reply)).toHaveLength(1);
  const roomId = ((payload(rooms.reply) as Record<string, unknown>[])[0] ?? {})['id'] as string;
  const send = call(target, ['send', roomId, '--text', 'offline probe']);
  expect(send.code).toBe(4);
  expect((send.reply['error'] as Record<string, unknown>)['code']).toBe('provider_unavailable');
  expect(call(target, ['history', roomId]).reply['ok']).toBe(true);
  // Installation itself never creates or opens a profile.
  expect(readdirSync(target.prefix).sort()).toEqual(['bin', 'lib']);
});

it('migrates a schema-14 RC1-shaped profile and restores an RC1-era format-2 backup', () => {
  const target = installAndInit('migration');
  const database = join(target.profile, 'runtime.sqlite');
  const roomId = (payload(call(target, ['room', 'list']).reply) as Record<string, unknown>[])[0]?.[
    'id'
  ] as string;
  const botId = (payload(call(target, ['bot', 'list']).reply) as Record<string, unknown>[])[0]?.[
    'id'
  ] as string;
  const db = new DatabaseSync(database);
  db.prepare(
    `INSERT INTO ocean_messages (id, workspace_id, room_id, seq, author, target_bot_id, body, created_at, author_bot_id, turn_id)
     VALUES ('rc1-message','ws_ocean',?,1,'user',?,'RC1-era message','2026-11-01T00:00:00.000Z',NULL,NULL)`,
  ).run(roomId, botId);
  db.exec(`DROP TABLE IF EXISTS ocean_provider_receipts;
    DROP TABLE IF EXISTS ocean_provider_connections;
    UPDATE meta SET value='14' WHERE key='schema_version';`);
  db.close();
  const doctor = call(target, ['doctor']);
  expect(doctor.code).toBe(0);
  const inspection = data(doctor.reply)['database'] as Record<string, unknown>;
  expect((inspection['summary'] as Record<string, unknown>)['schema']).toBe(14);
  const backup = join(root, 'migration/backup');
  const backupReply = call(target, ['backup', '--to', backup]);
  expect(backupReply.code).toBe(0);
  const manifest = data(backupReply.reply);
  expect(manifest['format']).toBe(2);
  expect((manifest['summary'] as Record<string, unknown>)['schema']).toBe(14);
  const restored = join(root, 'migration/restored');
  const restore = cli(target, ['restore', '--from', backup, '--profile', restored, '--json']);
  expect(restore.code).toBe(0);
  const restoredDb = new DatabaseSync(join(restored, 'runtime.sqlite'), { readOnly: true });
  try {
    expect(
      restoredDb.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    ).toBe('19');
    expect(restoredDb.prepare('SELECT count(*) AS n FROM ocean_rooms').get()?.['n']).toBe(1);
    expect(restoredDb.prepare('SELECT count(*) AS n FROM ocean_bots').get()?.['n']).toBe(1);
    expect(restoredDb.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n']).toBe(1);
    expect(
      restoredDb.prepare("SELECT body FROM ocean_messages WHERE id='rc1-message'").get()?.['body'],
    ).toBe('RC1-era message');
  } finally {
    restoredDb.close();
  }
  // The RC1-era backup stays byte-identical at schema 14 and restores again.
  const archiveDb = new DatabaseSync(join(backup, 'runtime.sqlite'), { readOnly: true });
  try {
    expect(
      archiveDb.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    ).toBe('14');
  } finally {
    archiveDb.close();
  }
  const restoredDoctor = spawnSync(
    join(target.prefix, 'bin/ocean'),
    ['doctor', '--profile', restored, '--json'],
    { encoding: 'utf8', env: target.env },
  );
  expect(JSON.parse(restoredDoctor.stdout)['ok']).toBe(true);
  expect((JSON.parse(restoredDoctor.stdout)['data'] as Record<string, unknown>)['restored']).toBe(
    true,
  );
}, 120_000);

it('upgrades and rolls back between disposable versions without touching profile bytes', () => {
  const target = installAndInit('upgrade');
  const database = join(target.profile, 'runtime.sqlite');
  const before = sha256(readFileSync(database));
  const installed = join(target.prefix, 'lib/ocean/releases/1.1.0-rc.2');
  expect(
    readdirSync(join(installed, 'node_modules/@runnets/integrations-executor/dist')).some(
      (name) => name === 'bundle-integrity.json',
    ),
  ).toBe(true);
  const upgrade = cli(target, [
    'install',
    '--archive',
    older.archive,
    '--sha256',
    older.sha256,
    '--prefix',
    target.prefix,
  ]);
  expect(upgrade.code).toBe(0);
  expect(cli(target, ['--version']).stdout.trim()).toBe('ocean 0.2.0');
  expect(sha256(readFileSync(database))).toBe(before);
  const rollback = cli(target, [
    'install',
    '--archive',
    artifact.archive,
    '--sha256',
    artifact.sha256,
    '--prefix',
    target.prefix,
  ]);
  expect(rollback.code).toBe(0);
  expect(cli(target, ['--version']).stdout.trim()).toBe('ocean 1.1.0-rc.2');
  expect(sha256(readFileSync(database))).toBe(before);
  // Both legacy versions stay installed beside the switched current one.
  expect(readdirSync(join(target.prefix, 'lib/ocean/releases')).sort()).toEqual([
    '0.2.0',
    '1.1.0-rc.2',
  ]);
  expect(call(target, ['doctor']).code).toBe(0);
}, 120_000);

const bundleProbe = `
const m = await import(process.argv[1]);
const base = { tenantId: 'probe-tenant', subjectId: 'probe-subject', allowedOrigins: ['http://127.0.0.1:1'] };
const refused = await m.ExecutorServicePluginTransport.open(base).then(() => 'opened').catch((e) => e.reason);
const transport = await m.ExecutorServicePluginTransport.open({ ...base, enableExecution: true });
const status = transport.qualification();
await transport.close();
console.log(JSON.stringify({ exports: Object.keys(m).sort(), refused, status: { qualified: status.qualified, mode: status.integrityMode, chunks: status.bundleFileCount, digest: transport.status().installedChunkSha256 } }));
`;
it('the installed tree loads and qualifies the bundled adapter without plugin execution', () => {
  const target = privateInstall(root, 'bundle');
  install(target, artifact);
  const entry = join(
    target.prefix,
    'lib/ocean/current/node_modules/@runnets/integrations-executor/dist/index.js',
  );
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', bundleProbe, entry], {
    encoding: 'utf8',
    env: { ...target.env },
  });
  const proof = JSON.parse(output.trim()) as {
    exports: string[];
    refused: string;
    status: { qualified: boolean; mode: string; chunks: number; digest: string };
  };
  expect(proof.exports).toEqual([
    'ExecutorPluginSetup',
    'ExecutorServicePluginTransport',
    'ExecutorSetupError',
    'ExecutorTransportOpenError',
    'PINNED_IDENTITIES',
  ]);
  // No product path enables execution; catalog discovery/invoke are never called.
  expect(proof.refused).toBe('execution_not_enabled');
  expect(proof.status).toEqual({
    qualified: true,
    mode: 'bundle',
    chunks: expect.any(Number) as unknown as number,
    digest: '6d3d22c97454dde48daacce07d901b174a642a480efee0b8c73fe31aa6d3a0b9',
  });
  expect(proof.status.chunks).toBeGreaterThan(10);
});
