import { expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { restoreProfile, backupProfile } from './snapshots.js';
import { openSqliteStore } from '@runnets/store-sqlite';
it('restores a genuinely old format1/schema5 manifest that predates Desktop summary fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-old-format1-'));
  try {
    const archive = join(root, 'archive');
    mkdirSync(archive, { mode: 0o700 });
    const path = join(archive, 'runtime.sqlite');
    closeSync(openSync(path, 'wx', 0o600));
    const db = new DatabaseSync(path);
    db.exec(
      readFileSync(
        new URL(
          '../../../../packages/store-sqlite/src/fixtures/ocean-schema-v5.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    db.close();
    const bytes = readFileSync(path);
    const manifest = {
      format: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      cli: '1.0',
      node: 'v24.0.0',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      summary: {
        schema: 5,
        rooms: 0,
        messages: 0,
        positions: [],
        pendingEffects: 0,
        unfinishedRuns: 0,
        heldRooms: 0,
      },
    };
    writeFileSync(join(archive, 'snapshot.json'), JSON.stringify(manifest), { mode: 0o600 });
    expect(restoreProfile(archive, join(root, 'restored'))).toEqual(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('keeps format1 text-only restore available for the additive Desktop schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-new-format1-'));
  try {
    const profile = join(root, 'profile');
    mkdirSync(profile, { mode: 0o700 });
    const path = join(profile, 'runtime.sqlite');
    closeSync(openSync(path, 'wx', 0o600));
    openSqliteStore({ path }).close();
    const archive = join(root, 'archive'),
      manifest = await backupProfile(profile, archive);
    expect(restoreProfile(archive, join(root, 'restored'))).toEqual(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
