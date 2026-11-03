import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { GitCodingApplyProject, verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import { backupProfile, restoreProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('retains scoped completion versus unknown SQLite outcomes and ambiguous legacy publication aliases/conflict after all sources vanish', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-profile-recovery-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false);
  try {
    const inventory = readCodingBackupInventory(join(f.directory, 'runtime.sqlite')),
      common = inventory.worktrees[0]!.gitCommonDir,
      context = {
        ownerId: inventory.tasks[0]!.ownerId,
        taskId: 'task',
        applicationId: 'scoped',
        changesetHash: f.changeset.hash,
      },
      writer = new GitCodingApplyProject();
    for (const file of f.changeset.files) await writer.applyFile(f.project, file, context);
    const scopes = join(common, 'ocean-apply-recovery-v2'),
      scope = fs.readdirSync(scopes)[0]!,
      files = join(scopes, scope, 'files'),
      legacy = join(common, 'ocean-apply-recovery');
    fs.mkdirSync(legacy, { mode: 0o700 });
    for (const name of fs.readdirSync(files).filter((n) => n.endsWith('.json'))) {
      const intent = JSON.parse(fs.readFileSync(join(files, name), 'utf8'));
      fs.writeFileSync(join(legacy, name), JSON.stringify({ ...intent, status: 'started' }), {
        mode: 0o600,
      });
      if (intent.before)
        fs.writeFileSync(join(legacy, intent.backup), 'conflicting retained preimage', {
          mode: 0o600,
        });
      fs.linkSync(join(f.project, intent.path), join(legacy, intent.staged));
    }
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
    try {
      for (const id of ['scoped', 'legacy-one', 'legacy-two'])
        db.prepare('INSERT INTO ocean_coding_applications VALUES(?,?)').run(
          id,
          JSON.stringify({
            id,
            taskId: 'task',
            changesetHash: f.changeset.hash,
            expectedBase: f.base,
            status: 'uncertain',
            ...(id === 'scoped' ? { recoveryProtocol: 2 } : {}),
            files: f.changeset.files.map((file) => ({ path: file.path, status: 'uncertain' })),
          }),
        );
    } finally {
      db.close();
    }
    const archive = join(root, 'archive'),
      manifest = await backupProfile(f.directory, archive, {
        managedDirectory: join(f.directory, 'worktrees'),
      });
    fs.rmSync(f.directory, { recursive: true });
    fs.rmSync(join(root, 'userdata'), { recursive: true });
    expect(verifyProfileBackupEnvelope(archive)).toEqual(manifest);
    const quarantine = join(root, 'quarantine');
    restoreProfile(archive, quarantine);
    const catalog = JSON.parse(
      fs.readFileSync(join(quarantine, 'assets', 'relationships.json'), 'utf8'),
    );
    expect(
      catalog.recovery.applications.find((a: { id: string }) => a.id === 'scoped'),
    ).toMatchObject({ status: 'uncertain', observedProtocol: 2 });
    expect(catalog.recovery.legacy[0].records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'math.cjs',
          original: 'conflict',
          ambiguous: true,
          candidateApplicationIds: ['legacy-one', 'legacy-two'],
        }),
      ]),
    );
    const legacyCatalog = catalog.recovery.legacy[0];
    for (const record of legacyCatalog.records) {
      const tree = join(quarantine, 'assets', 'recovery', 'legacy-' + legacyCatalog.slot, 'tree');
      expect(fs.readFileSync(join(tree, record.id + '.after'), 'utf8')).toBe(
        record.path === 'math.cjs' ? 'module.exports=42;\n' : 'immutable changeset\n',
      );
      if (record.path === 'math.cjs')
        expect(fs.readFileSync(join(tree, record.id + '.before'), 'utf8')).toBe(
          'conflicting retained preimage',
        );
    }
    const scopedCatalog = catalog.recovery.applications.find(
      (a: { id: string }) => a.id === 'scoped',
    );
    const math = scopedCatalog.records.find((r: { path: string }) => r.path === 'math.cjs');
    const scopedTree = join(
      quarantine,
      'assets',
      'recovery',
      'scoped-' + scopedCatalog.slot,
      'tree',
      'files',
    );
    expect(fs.readFileSync(join(scopedTree, math.id + '.before'), 'utf8')).toBe(
      'module.exports=(a,b)=>0;\n',
    );
    expect(fs.existsSync(join(scopedTree, math.id + '.after'))).toBe(false);
    expect(
      readCodingBackupInventory(join(quarantine, 'runtime.sqlite')).applications.every(
        (a) => a.status === 'uncertain',
      ),
    ).toBe(true);
  } finally {
    f.close();
  }
});
