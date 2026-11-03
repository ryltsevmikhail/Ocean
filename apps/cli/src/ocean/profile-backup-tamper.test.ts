import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyCodingDependencyArchive, verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import { backupProfile, restoreProfile } from './snapshots.js';
const roots: string[] = [];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) =>
  fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const rehash = <T extends { hash: string }>(value: T): T => {
  const { hash: _hash, ...body } = value;
  return { ...body, hash: hash(body) } as T;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('independently refuses malformed membership and recomputed semantic tampering after source deletion', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-profile-tamper-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false),
    original = join(root, 'original');
  try {
    await backupProfile(f.directory, original, {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    fs.rmSync(f.directory, { recursive: true });
    for (const kind of [
      'extra',
      'missing',
      'corrupt',
      'duplicate-json',
      'unsupported',
      'incomplete',
      'duplicate-task',
      'unknown-field',
      'required-tree',
      'dependency-inventory',
      'sqlite-summary',
    ]) {
      const archive = join(root, kind);
      fs.cpSync(original, archive, { recursive: true, preserveTimestamps: true });
      const rootFile = join(archive, 'snapshot.json'),
        catalogFile = join(archive, 'assets', 'catalog.json');
      let manifest = read(rootFile),
        catalog = read(catalogFile);
      if (kind === 'extra') fs.writeFileSync(join(archive, 'extra'), 'unlisted', { mode: 0o600 });
      if (kind === 'incomplete')
        fs.writeFileSync(join(archive, '.incomplete'), '{}', { mode: 0o600 });
      if (kind === 'missing' || kind === 'corrupt') {
        const blobs = join(
          archive,
          'assets',
          'worktrees',
          catalog.worktrees.worktrees[0].slot,
          'blobs',
        );
        const file = join(blobs, fs.readdirSync(blobs)[0]!);
        if (kind === 'missing') fs.unlinkSync(file);
        else fs.appendFileSync(file, 'corrupt');
      }
      if (kind === 'duplicate-json')
        fs.writeFileSync(rootFile, fs.readFileSync(rootFile, 'utf8').replace('{', '{"format":2,'));
      if (kind === 'unsupported') write(rootFile, { ...manifest, format: 3 });
      if (kind === 'sqlite-summary')
        write(rootFile, {
          ...manifest,
          summary: { ...manifest.summary, messages: manifest.summary.messages + 1 },
        });
      if (kind === 'duplicate-task') catalog.inventory.tasks.push(catalog.inventory.tasks[0]);
      if (kind === 'unknown-field') catalog.recovery.extra = 'unsupported';
      if (kind === 'required-tree') {
        const directory = join(archive, 'assets', 'dependencies'),
          dependency = read(join(directory, 'catalog.json'));
        fs.rmSync(join(directory, 'tree-' + dependency.tasks[0].treeHash), { recursive: true });
        const empty = {
          format: 1,
          entries: [
            { path: '', kind: 'directory', mode: 0o700 },
            { path: 'workspace', kind: 'directory', mode: 0o700 },
          ],
          bytes: 0,
        };
        dependency.tasks[0] = {
          ...dependency.tasks[0],
          treeHash: null,
          treeSelection: 'not-supplied',
          virtualHash: hash(empty),
          links: [],
        };
        catalog.dependencies = rehash(dependency);
        write(join(directory, 'catalog.json'), catalog.dependencies);
        // This is a valid selected dependency subset, but it cannot replace a DB-required ready tree.
        expect(verifyCodingDependencyArchive(directory)).toEqual(catalog.dependencies);
      }
      if (kind === 'dependency-inventory') {
        const directory = join(archive, 'assets', 'dependencies'),
          inventoryPath = join(directory, 'inventory.json');
        let inventory = read(inventoryPath);
        inventory.tasks[0].status = 'cancelled';
        inventory = rehash(inventory);
        write(inventoryPath, inventory);
        catalog.dependencies = rehash({ ...catalog.dependencies, inventoryHash: inventory.hash });
        write(join(directory, 'catalog.json'), catalog.dependencies);
        expect(verifyCodingDependencyArchive(directory)).toEqual(catalog.dependencies);
      }
      if (
        ['duplicate-task', 'unknown-field', 'required-tree', 'dependency-inventory'].includes(kind)
      ) {
        catalog = rehash(catalog);
        write(catalogFile, catalog);
        manifest = {
          ...manifest,
          assets: {
            ...manifest.assets,
            catalog: catalog.hash,
            dependencies: catalog.dependencies.hash,
          },
        };
        write(rootFile, manifest);
      }
      if (kind !== 'sqlite-summary')
        expect(() => verifyProfileBackupEnvelope(archive), kind).toThrow();
      expect(() => restoreProfile(archive, join(root, 'restore-' + kind)), kind).toThrow(
        'invalid_backup',
      );
      expect(fs.existsSync(join(root, 'restore-' + kind)), kind).toBe(false);
    }
  } finally {
    f.close();
  }
});
it('refuses quarantine inside its source archive before creating an entry', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-restore-admission-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false);
  try {
    const archive = join(root, 'archive');
    await backupProfile(f.directory, archive, { managedDirectory: join(f.directory, 'worktrees') });
    fs.rmSync(f.directory, { recursive: true });
    const before = fs.readdirSync(archive);
    expect(() => restoreProfile(archive, join(archive, 'quarantine'))).toThrow();
    expect(fs.readdirSync(archive)).toEqual(before);
    expect(fs.existsSync(join(archive, 'quarantine'))).toBe(false);
  } finally {
    f.close();
  }
});
