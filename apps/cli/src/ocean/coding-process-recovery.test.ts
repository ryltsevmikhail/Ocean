import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killAt } from '../../test-fixtures/coding-apply-worker.test.js';
import { codingWorkflowFixture, repairedMath } from './coding-workflow-fixture.js';
import { expect, it } from 'vitest';
import {
  openSqliteStore,
  snapshotCodingDatabase,
  readCodingBackupInventory,
  inspectDatabase,
} from '@runnets/store-sqlite';
import { createRuntime } from '../runtime.js';
import {
  codingApplyRecoverySlot,
  captureScopedCodingApplyRecovery,
  captureCodingRecoveryAssets,
  archiveCodingAssetTree,
  restoreCodingAssetTree,
} from '@runnets/tools-node';

it
  .runIf(process.platform === 'linux')
  .each([
    'intent',
    'started',
    'scope_header',
    'rename',
    'published',
    'unlinked',
    'file',
    'partial',
    'all_files',
  ])(
  'holds a real apply process killed at %s without replay or inferred completion',
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), 'ocean-coding-crash-'));
    const project = join(directory, 'project'),
      path = join(directory, 'runtime.sqlite');
    mkdirSync(project);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      for (const name of ['a', 'b', 'c']) writeFileSync(join(project, name), 'old-' + name);
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'base',
      );
      const base = git('rev-parse', 'HEAD');
      await killAt(path, project, phase);
      const before = ['a', 'b', 'c'].map((name) =>
        existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : null,
      );
      const effects = existsSync(path + '.effects') ? readFileSync(path + '.effects', 'utf8') : '';
      const context = {
        ownerId: 'fixture',
        taskId: 'task',
        applicationId: 'apply',
        changesetHash: 'a'.repeat(64),
      };
      const common = join(project, '.git');
      const scope = join(
        common,
        'ocean-apply-recovery-v2',
        codingApplyRecoverySlot(project, context),
      );
      const header = phase === 'scope_header' ? readFileSync(join(scope, 'scope.json')) : null;
      if (header) {
        expect(header.toString()).toBe(
          JSON.stringify({
            version: 2,
            root: project,
            ownerId: 'fixture',
            taskId: 'task',
            applicationId: 'apply',
            changesetHash: 'a'.repeat(64),
          }) + '\n',
        );
        expect(before).toEqual(['old-a', 'old-b', 'old-c']);
        expect(existsSync(join(scope, 'files'))).toBe(false);
      }
      for (let reopen = 0; reopen < 2; reopen++) {
        const runtime = createRuntime({ dbPath: path });
        try {
          const recovery = await runtime.ready;
          expect(recovery.effects).toMatchObject([
            { id: 'apply', tool: 'coding_apply', outcome: 'uncertain' },
          ]);
          const store = openSqliteStore({ path });
          try {
            const receipt = store.codingApplications.atomic((tx) => tx.application('apply'))!;
            expect(receipt.recoveryProtocol).toBe(2);
            const observed = captureScopedCodingApplyRecovery(common, project, context, {
              ...receipt,
              recoveryProtocol: receipt.recoveryProtocol ?? null,
            });
            expect(observed.presence).toBe(
              phase === 'intent' || phase === 'started'
                ? 'absent'
                : phase === 'scope_header'
                  ? 'header-only'
                  : ['rename', 'published', 'unlinked'].includes(phase)
                    ? 'incomplete'
                    : 'scoped',
            );
            if (phase === 'published' || phase === 'unlinked') {
              expect(before).toEqual(['new-a', 'old-b', 'old-c']);
              expect(effects).toBe('a\n');
              const record = observed.records[0]!;
              expect(record).toMatchObject({ path: 'a', status: 'started', original: 'matching' });
              const prefix = join(scope, 'files', record.id);
              expect(readFileSync(prefix + '.before', 'utf8')).toBe('old-a');
              expect(existsSync(prefix + '.after')).toBe(phase === 'published');
              if (phase === 'published') {
                expect(record).toMatchObject({ publicationLink: 'matching' });
                expect(readFileSync(prefix + '.after', 'utf8')).toBe('new-a');
                expect(statSync(prefix + '.after').ino).toBe(statSync(join(project, 'a')).ino);
                expect(statSync(prefix + '.after').nlink).toBe(2);
              }
            }
            expect(observed.status).toBe('uncertain');
            if (header)
              expect(observed.capture?.manifest.entries).toMatchObject([
                { path: '', kind: 'directory' },
                { path: 'scope.json', kind: 'file', bytes: header.byteLength },
              ]);
            expect(receipt.status).toBe('uncertain');
            expect(receipt.files.map((file) => file.status)).toEqual(
              phase === 'intent'
                ? ['pending', 'pending', 'pending']
                : phase === 'partial'
                  ? ['completed', 'uncertain', 'pending']
                  : phase === 'all_files'
                    ? ['completed', 'completed', 'completed']
                    : ['uncertain', 'pending', 'pending'],
            );
            expect(
              store.codingApplications.atomic((tx) =>
                tx.claimApplication({ ...receipt, status: 'applying' }),
              ),
            ).toBe(false);
          } finally {
            store.close();
          }
        } finally {
          runtime.close();
        }
        if (header) {
          expect(readFileSync(join(scope, 'scope.json'))).toEqual(header);
          expect(existsSync(join(scope, 'files'))).toBe(false);
          expect(readdirSync(scope)).toEqual(['scope.json']);
        }
      }
      expect(
        ['a', 'b', 'c'].map((name) =>
          existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : null,
        ),
      ).toEqual(before);
      expect(existsSync(path + '.effects') ? readFileSync(path + '.effects', 'utf8') : '').toBe(
        effects,
      );
      expect(git('rev-parse', 'HEAD')).toBe(base);
      expect(git('diff', '--cached')).toBe('');
      if (phase === 'rename') {
        expect(before[0]).toBeNull();
        const recovery = join(scope, 'files');
        expect(
          readFileSync(
            join(
              recovery,
              readdirSync(recovery).find((name) => name.endsWith('.before'))!,
            ),
            'utf8',
          ),
        ).toBe('old-a');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20000,
);

it.runIf(process.platform === 'linux')(
  'captures a published link in the graph under frozen SQLite maintenance ownership',
  async () => {
    const f = await codingWorkflowFixture('direct');
    try {
      writeFileSync(join(f.worktree, 'math.cjs'), repairedMath);
      const artifact = await f.capture('publication');
      f.runtime.close();
      const db = join(f.directory, 'runtime.sqlite');
      const { ownerId } = readCodingBackupInventory(db).tasks[0]!;
      await killAt(db, f.project, 'published', {
        ownerId,
        changesetHash: artifact.hash,
        base: f.base,
        changes: artifact.files,
      });
      const recovered = createRuntime({ dbPath: db });
      try {
        expect((await recovered.ready).effects).toMatchObject([
          { id: 'apply', outcome: 'uncertain' },
        ]);
      } finally {
        recovered.close();
      }
      const archive = join(f.directory, 'archive'),
        quarantine = join(f.directory, 'quarantine');
      const published = join(f.project, 'math.cjs'),
        inode = statSync(published).ino;
      const snapshot = await snapshotCodingDatabase(
        db,
        join(f.directory, 'frozen.sqlite'),
        (inventory) => {
          expect(inspectDatabase(db).status).toBe('owner_busy');
          return captureCodingRecoveryAssets(
            inventory,
            join(f.directory, 'worktrees'),
            async ({ capture }) => {
              archiveCodingAssetTree(capture, archive);
            },
          );
        },
      );
      expect(snapshot.assets.applications).toMatchObject([
        {
          id: 'apply',
          declaredProtocol: 2,
          status: 'uncertain',
          presence: 'incomplete',
          unknown: ['math.cjs'],
          records: [
            {
              path: 'math.cjs',
              status: 'started',
              publicationLink: 'matching',
              original: 'matching',
            },
          ],
        },
      ]);
      restoreCodingAssetTree(archive, quarantine);
      const restored = join(
        quarantine,
        'tree/files',
        snapshot.assets.applications[0]!.records[0]!.id + '.after',
      );
      expect(readFileSync(restored, 'utf8')).toBe(repairedMath);
      expect(statSync(restored).nlink).toBe(1);
      expect(statSync(restored).ino).not.toBe(inode);
      expect(statSync(published)).toMatchObject({ ino: inode, nlink: 2 });
      expect(readFileSync(published, 'utf8')).toBe(repairedMath);
    } finally {
      f.close();
    }
  },
);
