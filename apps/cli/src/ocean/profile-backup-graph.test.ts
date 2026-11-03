import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { readCodingBackupInventory, readDesktopBackupInventory } from '@runnets/store-sqlite';
import { verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import { backupProfile, restoreProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function environment() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-profile-graph-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'userdata'));
  return root;
}
it('independently verifies and restores coding, dependencies, configuration and Desktop from genuine frozen SQLite after every source disappears', async () => {
  const root = environment(),
    f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'));
  try {
    const imageId = '42345678-1234-4123-8123-123456789abc',
      imageRequest = '52345678-1234-4123-8123-123456789abc';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5aUAAAAASUVORK5CYII=',
      'base64',
    );
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
    const info = {
      id: imageId,
      name: 'pixel.png',
      bytes: png.length,
      sha256: sha(png),
      kind: 'image',
      mime: 'image/png',
    };
    fs.mkdirSync(join(f.desktop, f.room, imageId), { mode: 0o700 });
    fs.writeFileSync(join(f.desktop, f.room, imageId, 'blob'), png, { mode: 0o600 });
    fs.writeFileSync(join(f.desktop, f.room, imageId, 'metadata.json'), JSON.stringify(info), {
      mode: 0o600,
    });
    const body =
      'sent image\n\n[Ocean Desktop attachments v1]\n' +
      JSON.stringify({ version: 1, requestId: imageRequest, files: [info] });
    const receipt = {
      body: 'sent image',
      ids: [imageId],
      to: null,
      prepared: body,
      digest: sha(body),
    };
    fs.writeFileSync(join(f.desktop, f.room, imageRequest + '.json'), JSON.stringify(receipt), {
      mode: 0o600,
    });
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
    try {
      const bot = String(
        db.prepare('SELECT bot_id FROM ocean_rooms WHERE id=?').get(f.room)!['bot_id'],
      );
      db.prepare("INSERT INTO ocean_messages VALUES(?,?,?,1,'user',?,?,?,NULL,NULL)").run(
        'sent-image',
        'ws_ocean',
        f.room,
        bot,
        body,
        '2026-11-03T00:00:00Z',
      );
      db.prepare('INSERT INTO ocean_receipts VALUES(?,?,?)').run(
        imageRequest,
        JSON.stringify(['SendDirect', 'ws_ocean', f.room, body, null]),
        JSON.stringify({
          kind: 'message',
          data: { id: 'sent-image', roomId: f.room, workspaceId: 'ws_ocean' },
        }),
      );
      db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'completed',?)").run(
        'prepare:' + f.room + ':' + imageRequest,
        JSON.stringify({
          room: f.room,
          requestId: imageRequest,
          body: 'sent image',
          to: null,
          ids: [imageId],
        }),
        JSON.stringify(receipt),
      );
    } finally {
      db.close();
    }
    const archive = join(root, 'archive'),
      manifest = await backupProfile(f.directory, archive, {
        managedDirectory: join(f.directory, 'worktrees'),
      });
    const slot = f.worktree.split('/').at(-1)!;
    fs.rmSync(f.directory, { recursive: true });
    fs.rmSync(f.deps, { recursive: true });
    fs.rmSync(f.bin, { recursive: true });
    fs.rmSync(join(root, 'userdata'), { recursive: true });
    expect(verifyProfileBackupEnvelope(archive)).toEqual(manifest);
    const restored = join(root, 'restored');
    expect(restoreProfile(archive, restored)).toEqual(manifest);
    const task = join(restored, 'assets', 'worktrees', slot, 'materialized', 'tree');
    expect(
      fs.readFileSync(join(task, 'workspace', 'node_modules', 'local', 'index.js'), 'utf8'),
    ).toBe('module.exports=42;');
    expect(fs.readFileSync(join(task, 'toolchain', 'pnpm', 'bin', 'pnpm'), 'utf8')).toBe(
      '#!/bin/sh\nprintf synthetic',
    );
    expect(fs.statSync(join(task, 'workspace', 'node_modules', 'pkg')).ino).toBe(
      fs.statSync(join(task, 'workspace', 'node_modules', 'copy')).ino,
    );
    expect(
      fs.readFileSync(join(restored, 'assets', 'desktop', 'tree', f.room, f.id, 'blob')),
    ).toEqual(Buffer.from([0, 255, 1, 2, 3]));
    expect(readCodingBackupInventory(join(restored, 'runtime.sqlite')).changesets[0]?.hash).toBe(
      f.changeset.hash,
    );
    const desktop = readDesktopBackupInventory(join(restored, 'runtime.sqlite'));
    expect(desktop.uploads[0]?.data).toBe('YQ==');
    expect(desktop.messages).toHaveLength(1);
    expect(desktop.messages[0]?.body).toBe(body);
    expect(
      fs.readFileSync(join(restored, 'assets', 'desktop', 'tree', f.room, imageId, 'blob')),
    ).toEqual(png);
    expect(desktop.operations[0]?.state).toBe('completed');
    const evidence = JSON.parse(
      fs.readFileSync(join(restored, 'assets', 'relationships.json'), 'utf8'),
    );
    expect(evidence.dependencies.projects[1].selection).toBe('metadata-only');
  } finally {
    f.close();
  }
});
