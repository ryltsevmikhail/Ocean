import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import { backupProfile, restoreProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('retains exact raw index, stages, resolve-undo and base closure after every source is deleted', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-profile-index-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false);
  const git = (cwd: string, args: string[], input?: string | Buffer) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { input, encoding: 'utf8' }).trim();
  try {
    const values = ['base-stage-content', 'ours-stage-content', 'theirs-stage-content'];
    const ids = values.map((value) => git(f.worktree, ['hash-object', '-w', '--stdin'], value));
    for (const path of ['unmerged', 'resolved'])
      git(
        f.worktree,
        ['update-index', '--index-info'],
        ids.map((id, i) => `100644 ${id} ${i + 1}\t${path}\n`).join(''),
      );
    fs.writeFileSync(join(f.worktree, 'resolved'), 'resolved content');
    git(f.worktree, ['add', 'resolved']);
    const stages = git(f.worktree, ['ls-files', '--stage']),
      undo = git(f.worktree, ['ls-files', '--resolve-undo']);
    expect(stages).toContain(ids[2]);
    expect(undo).toContain(ids[2]);
    const admin = fs.readFileSync(join(f.worktree, '.git'), 'utf8').slice(8).trim(),
      index = fs.readFileSync(join(admin, 'index'));
    const archive = join(root, 'backup'),
      manifest = await backupProfile(f.directory, archive, {
        managedDirectory: join(f.directory, 'worktrees'),
      });
    fs.rmSync(f.directory, { recursive: true });
    expect(verifyProfileBackupEnvelope(archive)).toEqual(manifest);
    const restored = join(root, 'quarantine');
    restoreProfile(archive, restored);
    const slots = fs.readdirSync(join(restored, 'assets', 'evidence', 'git'));
    const evidence = join(restored, 'assets', 'evidence', 'git', slots[0]!);
    expect(fs.readFileSync(join(evidence, 'index'))).toEqual(index);
    // Independently exercise only the inert copied pack/index in a newly owned test repository.
    const imported = join(root, 'proof');
    fs.mkdirSync(imported, { mode: 0o700 });
    git(imported, ['init', '-q']);
    git(imported, ['index-pack', '--stdin'], fs.readFileSync(join(evidence, 'pack')));
    fs.writeFileSync(join(imported, '.git', 'index'), fs.readFileSync(join(evidence, 'index')));
    expect(git(imported, ['ls-files', '--stage'])).toBe(stages);
    expect(git(imported, ['ls-files', '--resolve-undo'])).toBe(undo);
    for (const [i, id] of ids.entries())
      expect(git(imported, ['cat-file', 'blob', id])).toBe(values[i]);
    expect(git(imported, ['cat-file', '-t', f.base])).toBe('commit');
    expect(git(imported, ['show', f.base + ':math.cjs'])).toBe('module.exports=(a,b)=>0;');
  } finally {
    f.close();
  }
});
