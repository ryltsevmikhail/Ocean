import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
import {
  archivePartialCodingGit,
  verifyPartialCodingGitArchive,
} from './coding-git-partial-archive.js';
it.runIf(process.platform === 'linux').each(['partial', 'indexed', 'planned', 'root-absent'])(
  'independently retains and verifies partial Git/tree evidence for %s',
  async (shape) => {
    const f = partialFixture(shape);
    try {
      const archive = join(f.outer, 'git-evidence'),
        tree = join(f.outer, 'tree-evidence');
      let hash = '';
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async (input) => {
          hash = archivePartialCodingGit(input.git, archive);
          if (input.capture) archiveCodingAssetTree(input.capture, tree);
        },
      );
      // Source paths deliberately disappear; restored pointers remain inert evidence only.
      fs.rmSync(f.project, { recursive: true });
      fs.rmSync(f.managed, { recursive: true });
      const retained = verifyPartialCodingGitArchive(archive, hash);
      const restored = join(f.outer, 'independent');
      fs.mkdirSync(restored, { mode: 0o700 });
      f.git(restored, 'init', '-q', '--object-format=' + retained.objectFormat);
      execFileSync('/usr/bin/git', ['-C', restored, 'index-pack', '--stdin'], {
        input: retained.pack,
        env: f.env,
      });
      expect(f.git(restored, 'cat-file', '-p', retained.baseCommit + ':a')).toBe('base-a');
      if (retained.index) {
        fs.writeFileSync(join(restored, '.git/index'), retained.index);
        expect(f.git(restored, 'ls-files')).toBe('a\nb');
      } else expect(fs.existsSync(join(restored, '.git/index'))).toBe(false);
      if (fs.existsSync(tree)) {
        const quarantine = join(f.outer, 'quarantine');
        restoreCodingAssetTree(tree, quarantine);
        expect(fs.readFileSync(join(quarantine, 'tree/a'))).toEqual(Buffer.from([0, 255, 1]));
        expect(fs.statSync(join(quarantine, 'tree/a')).mode & 0o777).toBe(0o755);
      }
      fs.writeFileSync(join(archive, 'administration.json'), '{}');
      expect(() => verifyPartialCodingGitArchive(archive, hash)).toThrow();
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['pack', 'index'])(
  'refuses missing or corrupt retained %s evidence',
  async (name) => {
    const f = partialFixture('indexed');
    try {
      const archive = join(f.outer, 'evidence');
      let hash = '';
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async ({ git }) => {
          hash = archivePartialCodingGit(git, archive);
        },
      );
      const original = fs.readFileSync(join(archive, name));
      fs.writeFileSync(join(archive, name), Buffer.alloc(original.length));
      expect(() => verifyPartialCodingGitArchive(archive, hash)).toThrow();
      fs.unlinkSync(join(archive, name));
      expect(() => verifyPartialCodingGitArchive(archive, hash)).toThrow();
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['root', 'common'])(
  'refuses a Git evidence output inside its %s source before creating anything',
  async (kind) => {
    const f = partialFixture('indexed');
    try {
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async ({ git }) => {
          const destination = join(kind === 'root' ? f.root : f.common, 'evidence');
          expect(() => archivePartialCodingGit(git, destination)).toThrow(
            'invalid_coding_asset_destination',
          );
          expect(fs.existsSync(destination)).toBe(false);
        },
      );
    } finally {
      f.close();
    }
  },
);
