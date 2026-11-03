import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { desktopRootIdentity } from '@runnets/tools-node';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import type { Changeset } from '@runnets/domain';
export const byteHash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** Real frozen SQLite references; all files belong to the caller's synthetic fixture. */
export async function fullBackupFixture<
  T extends {
    directory: string;
    project: string;
    worktree: string;
    room: string;
    runtime: { close(): void };
    capture(id: string): Promise<Changeset>;
  },
>(root: string, create: () => Promise<T>, dependencies = true) {
  const f = await create();
  const id = '12345678-1234-4123-8123-123456789abc',
    request = '22345678-1234-4123-8123-123456789abc',
    upload = '32345678-1234-4123-8123-123456789abc',
    desktop = join(f.directory, 'desktop-fixture'),
    deps = join(root, 'deps'),
    bin = join(root, 'bin');
  fs.mkdirSync(join(desktop, f.room, id), { recursive: true, mode: 0o700 });
  const info = {
    id,
    name: 'binary.bin',
    bytes: 5,
    sha256: byteHash(Buffer.from([0, 255, 1, 2, 3])),
    kind: 'file',
    mime: 'application/octet-stream',
  };
  fs.writeFileSync(join(desktop, f.room, id, 'blob'), Buffer.from([0, 255, 1, 2, 3]), {
    mode: 0o600,
  });
  fs.writeFileSync(join(desktop, f.room, id, 'metadata.json'), JSON.stringify(info), {
    mode: 0o600,
  });
  const prepared =
      'caption\n\n[Ocean Desktop attachments v1]\n' +
      JSON.stringify({ version: 1, requestId: request, files: [info] }),
    receipt = { body: 'caption', ids: [id], to: null, prepared, digest: byteHash(prepared) };
  fs.writeFileSync(join(desktop, f.room, request + '.json'), JSON.stringify(receipt), {
    mode: 0o600,
  });
  fs.writeFileSync(join(f.worktree, 'exact.txt'), 'immutable changeset\n');
  fs.writeFileSync(join(f.worktree, 'math.cjs'), 'module.exports=42;\n');
  const changeset = await f.capture('exact');
  if (dependencies) {
    fs.mkdirSync(join(f.worktree, 'packages', 'local'), { recursive: true });
    fs.writeFileSync(join(f.worktree, 'packages', 'local', 'index.js'), 'module.exports=42;');
    fs.mkdirSync(join(deps, 'node_modules'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(deps, 'node_modules', 'pkg'), Buffer.from([0, 255, 1]), { mode: 0o755 });
    fs.linkSync(join(deps, 'node_modules', 'pkg'), join(deps, 'node_modules', 'copy'));
    fs.symlinkSync('../packages/local', join(deps, 'node_modules', 'local'));
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nprintf synthetic', { mode: 0o755 });
  }
  f.runtime.close();
  fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const inventory = readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
  fs.writeFileSync(
    join(f.directory, 'coding-projects.json'),
    JSON.stringify([
      {
        id: 'registered',
        root: f.project,
        testPresets: inventory.tasks[0]!.policy.testPresets,
        ...(dependencies ? { dependencyProjectRoot: deps } : {}),
        mounts: dependencies
          ? [
              { source: join(deps, 'node_modules'), target: '/workspace/node_modules' },
              { source: join(bin, 'pnpm'), target: '/toolchain/pnpm/bin/pnpm' },
            ]
          : [],
      },
      { id: 'metadata_only', root: join(root, 'never-open'), testPresets: [], mounts: [] },
    ]),
    { mode: 0o600 },
  );
  const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
  try {
    db.prepare("INSERT INTO meta VALUES('desktop_assets_binding',?)").run(
      JSON.stringify({
        profileId: byteHash(f.directory),
        root: desktop,
        originalRoot: join(root, 'userdata'),
        identity: desktopRootIdentity(desktop),
      }),
    );
    db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'completed',?)").run(
      'prepare:' + f.room + ':' + request,
      JSON.stringify({ room: f.room, requestId: request, body: 'caption', to: null, ids: [id] }),
      JSON.stringify(receipt),
    );
    db.prepare('INSERT INTO ocean_desktop_uploads VALUES(?,?,?,?,?,?)').run(
      upload,
      f.room,
      'pending.bin',
      3,
      byteHash('abc'),
      Buffer.from('a').toString('base64'),
    );
  } finally {
    db.close();
  }
  return { ...f, id, request, desktop, deps, bin, changeset };
}
