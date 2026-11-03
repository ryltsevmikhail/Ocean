import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
it
  .runIf(process.platform === 'linux')
  .each(['planned', 'branch-only', 'root-absent', 'no-checkout', 'partial', 'indexed'])(
  'retains base and explicit partial creation evidence for %s without repair',
  async (shape) => {
    const f = partialFixture(shape);
    try {
      let consumed = false;
      const catalog = await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {
          throw Error('partial sent to ready consumer');
        },
        async (input) => {
          consumed = true;
          expect(input.git.objectIds).toContain(f.worktree.baseCommit);
          expect(input.git.index === null).toBe(shape !== 'indexed');
          expect(input.capture === null).toBe(
            ['planned', 'branch-only', 'root-absent'].includes(shape),
          );
          expect(input.git.administration.root).toBe(input.capture ? 'present' : 'absent');
        },
      );
      expect(consumed).toBe(true);
      expect(catalog.worktrees[0]).toMatchObject({ presence: 'partial', state: 'preparing' });
      expect(fs.existsSync(join(f.admin, 'index'))).toBe(shape === 'indexed');
      expect(fs.existsSync(f.root)).toBe(
        !['planned', 'branch-only', 'root-absent'].includes(shape),
      );
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses absence-only consumers that cannot retain base and administration evidence',
  async () => {
    const f = partialFixture('planned');
    try {
      await expect(
        captureCodingWorktreeAssets(f.inventory(), f.managed, async () => {}),
      ).rejects.toThrow('partial_coding_consumer_required');
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux')(
  'captures surviving common metadata with the original checkout missing',
  async () => {
    const f = partialFixture('partial', 'sha1', true);
    try {
      fs.rmSync(f.project, { recursive: true });
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async ({ git, capture }) => {
          expect(git.objectIds).toContain(f.worktree.baseCommit);
          expect(capture?.manifest.entries.find((entry) => entry.path === 'a')).toMatchObject({
            kind: 'file',
            bytes: 3,
            mode: 0o755,
          });
        },
      );
      expect(fs.existsSync(f.project)).toBe(false);
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['sha1', 'sha256'])(
  'retains packed %s base closure without index and ignores hostile configuration',
  async (format) => {
    const f = partialFixture('partial', format);
    try {
      f.git(f.project, 'pack-refs', '--all');
      f.git(f.project, 'repack', '-ad');
      const canary = join(f.outer, 'config-executed');
      fs.writeFileSync(
        join(f.common, 'config'),
        '[include]\npath = /nonexistent/malformed\n[core]\nfsmonitor = touch ' + canary + '\n',
      );
      fs.writeFileSync(join(f.home, '.gitconfig'), '[invalid');
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async ({ git }) => {
          expect(git.objectFormat).toBe(format);
          expect(git.index).toBeNull();
          expect(git.objectIds).toContain(f.worktree.baseCommit);
        },
      );
      expect(fs.existsSync(canary)).toBe(false);
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux').each(['common', 'base'])(
  'refuses missing required %s even when the planned root is absent',
  async (kind) => {
    const f = partialFixture('planned');
    try {
      if (kind === 'common') fs.rmSync(f.common, { recursive: true });
      else
        fs.unlinkSync(
          join(
            f.common,
            'objects',
            f.worktree.baseCommit.slice(0, 2),
            f.worktree.baseCommit.slice(2),
          ),
        );
      await expect(
        captureCodingWorktreeAssets(
          f.inventory(),
          f.managed,
          async () => {},
          async () => {},
        ),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  },
);
it.runIf(process.platform === 'linux')(
  'retains raw index stages and resolve-undo roots for an uncertain preparation',
  async () => {
    const f = partialFixture('indexed');
    try {
      Object.assign(f.worktree, { state: 'uncertain' });
      const ids = ['base conflict', 'ours conflict', 'theirs conflict'].map((text) => {
        const temporary = join(f.outer, 'blob');
        fs.writeFileSync(temporary, text);
        return f.git(f.root, 'hash-object', '-w', temporary);
      });
      const { execFileSync } = await import('node:child_process');
      execFileSync('/usr/bin/git', ['-C', f.root, 'update-index', '--index-info'], {
        env: f.env,
        input: ids.map((id, n) => `100644 ${id} ${n + 1}\tconflict\n`).join(''),
      });
      fs.writeFileSync(join(f.root, 'conflict'), 'resolved');
      f.git(f.root, 'add', 'conflict');
      const raw = fs.readFileSync(join(f.admin, 'index'));
      await captureCodingWorktreeAssets(
        f.inventory(),
        f.managed,
        async () => {},
        async ({ git }) => {
          expect(git.index).toEqual(raw);
          for (const id of ids) expect(git.objectIds).toContain(id);
        },
      );
      expect(f.worktree.state).toBe('uncertain');
    } finally {
      f.close();
    }
  },
);
