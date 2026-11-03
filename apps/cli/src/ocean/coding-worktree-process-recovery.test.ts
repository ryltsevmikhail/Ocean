import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  captureCodingWorktreeAssets,
  archiveCodingAssetTree,
  archivePartialCodingGit,
  verifyPartialCodingGitArchive,
} from '@runnets/tools-node';
import {
  readCodingBackupInventory,
  snapshotCodingDatabase,
  inspectDatabase,
} from '@runnets/store-sqlite';
import { createRuntime } from '../runtime.js';
import { killCreateAt } from '../../test-fixtures/coding-create-worker.test.js';
import type { CodingAccess } from '@runnets/domain';
it
  .runIf(process.platform === 'linux')
  .each([
    'planned',
    'before_chmod',
    'no_checkout',
    'materializing',
    'before_read_tree',
    'after_read_tree',
  ])(
  'captures actual interrupted creation at %s across two reopenings without replay or promotion',
  async (phase) => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-create-crash-')),
      home = join(outer, 'home'),
      project = join(outer, 'project'),
      managed = join(outer, 'worktrees'),
      db = join(outer, 'runtime.sqlite');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(project);
    vi.stubEnv('HOME', home);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', project, ...args], {
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
        encoding: 'utf8',
      }).trim();
    try {
      git('init', '-q');
      for (const name of ['a', 'b']) fs.writeFileSync(join(project, name), 'base-' + name);
      git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
      await killCreateAt(outer, home, phase);
      const initial = readCodingBackupInventory(db),
        worktree = initial.worktrees[0]!;
      expect(worktree.state).toBe('preparing');
      const rootPresent = phase !== 'planned';
      expect(fs.existsSync(worktree.root)).toBe(rootPresent);
      if (phase === 'before_chmod') expect(fs.statSync(worktree.root).mode & 0o777).toBe(0o755);
      const names = rootPresent ? fs.readdirSync(worktree.root).sort() : [];
      expect(names).toEqual(
        phase === 'planned'
          ? []
          : ['before_chmod', 'no_checkout'].includes(phase)
            ? ['.git']
            : phase === 'materializing'
              ? ['.git', 'a']
              : ['.git', 'a', 'b'],
      );
      const before = names.map((name) => ({
        name,
        bytes: fs.readFileSync(join(worktree.root, name)),
        stat: fs.statSync(join(worktree.root, name), { bigint: true }),
      }));
      const access = JSON.parse(
        fs.readFileSync(join(outer, 'access.json'), 'utf8'),
      ) as CodingAccess;
      for (let reopen = 0; reopen < 2; reopen++) {
        const runtime = createRuntime({ dbPath: db, codingWorktreeDirectory: managed });
        try {
          await runtime.ready;
          const denied = await runtime.codingChanges.prepare(access, {
            confirm: async () => {
              throw Error('must not reapprove');
            },
          });
          expect(denied).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
        } finally {
          runtime.close();
        }
        expect(readCodingBackupInventory(db).worktrees[0]).toEqual(worktree);
        let archiveHash = '';
        const evidence = join(outer, 'evidence-' + reopen);
        const snapshot = await snapshotCodingDatabase(
          db,
          join(outer, 'frozen-' + reopen + '.sqlite'),
          (inventory) => {
            expect(inspectDatabase(db).status).toBe('owner_busy');
            return captureCodingWorktreeAssets(
              inventory,
              managed,
              async () => {
                throw Error('partial promoted');
              },
              async (input) => {
                expect(input.git.index === null).toBe(phase !== 'after_read_tree');
                archiveHash = archivePartialCodingGit(input.git, evidence);
                if (input.capture)
                  archiveCodingAssetTree(input.capture, join(outer, 'tree-' + reopen));
              },
            );
          },
        );
        expect(snapshot.assets.worktrees[0]).toMatchObject({
          presence: 'partial',
          state: 'preparing',
        });
        expect(verifyPartialCodingGitArchive(evidence, archiveHash).baseCommit).toBe(
          worktree.baseCommit,
        );
        expect(fs.readFileSync(join(outer, 'dispatches'), 'utf8')).toBe('create\n');
        for (const entry of before) {
          expect(fs.readFileSync(join(worktree.root, entry.name))).toEqual(entry.bytes);
          expect(fs.statSync(join(worktree.root, entry.name), { bigint: true })).toMatchObject({
            ino: entry.stat.ino,
            mode: entry.stat.mode,
            mtimeNs: entry.stat.mtimeNs,
            ctimeNs: entry.stat.ctimeNs,
          });
        }
      }
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
  30000,
);
