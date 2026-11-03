import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
export async function currentBackup(f, room, assets) {
  const archive = join(f.root, 'full-backup'),
    restored = join(f.root, 'restored');
  const outcomes = [];
  const command = (expected, ...args) => {
    let code = 0,
      output;
    try {
      output = execFileSync(process.execPath, [f.cli, ...args, '--json'], {
        env: f.env,
        encoding: 'utf8',
      });
    } catch (e) {
      code = e.status;
      output = e.stdout;
    }
    outcomes.push({ args, code, output });
    appendFileSync(
      join(f.root, 'backup-commands.jsonl'),
      JSON.stringify({ args, code, output }) + '\n',
    );
    assert.equal(code, expected, output);
    return JSON.parse(output);
  };
  const sourceHistory = f.command('history', room);
  const backup = command(0, 'backup', '--profile', f.profile, '--to', archive);
  assert.equal(backup.data.format, 2);
  // Every process has been awaited before deleting this exact owned source.
  assert.ok(f.profile.startsWith(f.root + '/'));
  rmSync(f.profile, { recursive: true });
  command(0, 'restore', '--from', archive, '--profile', restored);
  command(0, 'doctor', '--profile', restored);
  const history = command(0, 'history', room, '--profile', restored);
  assert.deepEqual(history.data, sourceHistory);
  assert.match(JSON.stringify(history), /attachment note/);
  command(4, 'runtime', 'start', '--profile', restored);
  command(4, 'send', room, '--text', 'must not replay', '--profile', restored);
  assert.equal(readFileSync(join(restored, 'restore-guard.json'), 'utf8').includes('ready'), true);
  const db = new DatabaseSync(join(restored, 'runtime.sqlite'), { readOnly: true });
  const binding = JSON.parse(
    db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get().value,
  );
  for (const asset of assets) {
    const data = readFileSync(join(restored, 'assets', 'desktop', 'tree', room, asset.id, 'blob'));
    assert.equal(data.length, asset.bytes);
    assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256);
  }
  const first = JSON.parse(
    db
      .prepare(
        "SELECT result FROM ocean_desktop_operations WHERE id LIKE 'prepare:%' AND result LIKE '%detach-turn%'",
      )
      .get().result,
  );
  assert.equal(
    readFileSync(join(restored, 'assets', 'desktop', 'tree', room, first.ids[0], 'blob'), 'utf8'),
    'exact fixture attachment',
  );
  const preparation = db
    .prepare(
      "SELECT count(*) AS n FROM ocean_desktop_operations WHERE id LIKE 'prepare:%' AND state='completed'",
    )
    .get();
  assert.ok(preparation.n >= 2);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%approval%' OR name LIKE '%claim%')",
    )
    .all();
  const inertCounts = Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db.prepare('SELECT count(*) AS n FROM "' + name + '"').get().n,
    ]),
  );
  assert.ok(Object.values(inertCounts).every((n) => n === 0));
  db.close();
  writeFileSync(
    join(f.root, 'backup-proof.json'),
    JSON.stringify(
      {
        archive,
        restored,
        binding,
        preparation,
        sourceHistory,
        firstAttachmentId: first.ids[0],
        inertCounts,
        outcomes,
        restoredFiles: readdirSync(restored),
      },
      null,
      2,
    ),
  );
}
