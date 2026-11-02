import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  unlinkSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitCodingWorktrees } from './coding-worktree.js';
import { GitCodingSnapshots } from './coding-snapshot.js';
import type { CodingTask } from '@runnets/domain';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-worktree-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(project, 'edit.txt'), 'before\n');
  writeFileSync(join(project, 'delete.txt'), 'delete\n');
  writeFileSync(join(project, 'mode.sh'), 'echo ok\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const task = {
    id: 'task',
    workspaceId: 'ws',
    projectRoot: project,
    baseCommit: git('rev-parse', 'HEAD'),
    worktreeRoot: null,
    ownerRoomId: 'room',
    devBotId: 'dev',
    reviewBotId: 'review',
    reviewRoomId: 'room',
    status: 'reserved',
    policyVersion: 1,
    policy: {
      version: 1,
      devCapabilities: ['project_read'],
      reviewCapabilities: ['changeset_read'],
      testPresets: [],
    },
    lease: {
      projectRoot: project,
      ownerId: 'profile',
      taskId: 'task',
      requestId: 'start',
      binding: 'binding',
      kind: 'coding',
      token: 'token',
    },
    createdAt: new Date().toISOString(),
  } as CodingTask;
  const worktrees = new GitCodingWorktrees(join(root, 'worktrees'));
  return { root, project, git, task, worktrees };
}
it('creates a unique dedicated branch/worktree without modifying the source checkout', async () => {
  const s = setup(),
    plan = await s.worktrees.plan(s.task);
  const binding = await s.worktrees.create(s.task, plan);
  expect(binding.root).not.toBe(s.project);
  expect(binding.branch).toMatch(/^codex\/ocean\//);
  expect(readFileSync(join(binding.root, 'edit.txt'), 'utf8')).toBe('before\n');
  expect(s.git('status', '--porcelain')).toBe('');
  expect((await s.worktrees.plan(s.task)).root).toBe(binding.root);
  await expect(s.worktrees.create(s.task, plan)).rejects.toThrow();
});
it('refuses dirty source and never stashes or deletes user changes', async () => {
  const s = setup();
  writeFileSync(join(s.project, 'user.txt'), 'keep');
  const plan = await s.worktrees.plan(s.task);
  await expect(s.worktrees.create(s.task, plan)).rejects.toThrow();
  expect(readFileSync(join(s.project, 'user.txt'), 'utf8')).toBe('keep');
});
it('freezes full edits, additions (including staged), deletions and mode changes', async () => {
  const s = setup(),
    p = await s.worktrees.plan(s.task),
    binding = await s.worktrees.create(s.task, p);
  writeFileSync(join(binding.root, 'edit.txt'), 'after\n');
  unlinkSync(join(binding.root, 'delete.txt'));
  writeFileSync(join(binding.root, 'new.txt'), 'new file\n');
  writeFileSync(join(binding.root, 'staged.txt'), 'staged\n');
  execFileSync('/usr/bin/git', ['-C', binding.root, 'add', 'staged.txt']);
  chmodSync(join(binding.root, 'mode.sh'), 0o755);
  const snapshots = new GitCodingSnapshots(),
    a = await snapshots.capture(s.task, binding);
  expect(a.files.map((f) => f.path)).toEqual([
    'delete.txt',
    'edit.txt',
    'mode.sh',
    'new.txt',
    'staged.txt',
  ]);
  expect(a.files.find((f) => f.path === 'new.txt')).toMatchObject({
    before: null,
    after: { text: 'new file\n' },
  });
  expect(a.files.find((f) => f.path === 'mode.sh')).toMatchObject({
    before: { mode: '100644' },
    after: { mode: '100755' },
  });
  expect(a.diff).toContain('+++');
  expect(a.diff).toContain('new file');
  expect(a.afterTreeHash).not.toBe(a.beforeTreeHash);
  const saved = a.files.find((f) => f.path === 'edit.txt')?.after?.text;
  writeFileSync(join(binding.root, 'edit.txt'), 'later\n');
  expect(saved).toBe('after\n');
  expect((await snapshots.capture(s.task, binding)).hash).not.toBe(a.hash);
  expect(s.git('status', '--porcelain')).toBe('');
});
it('rejects unsupported changed binary/symlink/oversized files instead of truncating', async () => {
  const s = setup(),
    binding = await s.worktrees.create(s.task, await s.worktrees.plan(s.task)),
    snapshots = new GitCodingSnapshots();
  writeFileSync(join(binding.root, 'binary.bin'), Buffer.from([0, 1, 2]));
  await expect(snapshots.capture(s.task, binding)).rejects.toThrow();
  unlinkSync(join(binding.root, 'binary.bin'));
  symlinkSync('/etc/passwd', join(binding.root, 'link'));
  await expect(snapshots.capture(s.task, binding)).rejects.toThrow();
  unlinkSync(join(binding.root, 'link'));
  writeFileSync(join(binding.root, 'large.txt'), 'x'.repeat(131073));
  await expect(snapshots.capture(s.task, binding)).rejects.toThrow();
});
it('detects changes during capture and excludes protected/untracked credentials', async () => {
  const s = setup(),
    binding = await s.worktrees.create(s.task, await s.worktrees.plan(s.task));
  writeFileSync(join(binding.root, 'edit.txt'), 'after\n');
  writeFileSync(join(binding.root, '.env'), 'PRIVATE_CANARY');
  const snapshots = new GitCodingSnapshots({
    betweenScans: () => {
      writeFileSync(join(binding.root, 'edit.txt'), 'raced\n');
    },
  });
  await expect(snapshots.capture(s.task, binding)).rejects.toThrow('stale_capture');
  const valid = await new GitCodingSnapshots().capture(s.task, binding);
  expect(JSON.stringify(valid)).not.toContain('PRIVATE_CANARY');
  expect(valid.files.some((f) => f.path === '.git')).toBe(false);
});
it('never runs repository hooks or filters while populating or capturing', async () => {
  const s = setup(),
    marker = join(s.root, 'must-not-run');
  // Keep attributes committed before enabling any filter.
  writeFileSync(join(s.project, '.gitattributes'), '*.txt filter=evil\n');
  execFileSync('/usr/bin/git', [
    '-c',
    'core.fsmonitor=false',
    '-C',
    s.project,
    'add',
    '.gitattributes',
  ]);
  execFileSync('/usr/bin/git', [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-C',
    s.project,
    'commit',
    '-qm',
    'attributes',
  ]);
  s.task = {
    ...s.task,
    baseCommit: execFileSync(
      '/usr/bin/git',
      ['-c', 'core.fsmonitor=false', '-C', s.project, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim(),
  };
  s.git('config', 'core.fsmonitor', 'touch ' + marker);
  s.git('config', 'extensions.worktreeConfig', 'true');
  s.git('config', '--worktree', 'filter.evil.clean', 'touch ' + marker + '; cat');
  s.git('config', '--worktree', 'filter.evil.smudge', 'touch ' + marker + '; cat');
  expect(existsSync(marker)).toBe(false);
  const binding = await s.worktrees.create(s.task, await s.worktrees.plan(s.task));
  writeFileSync(join(binding.root, 'edit.txt'), 'after\n');
  await new GitCodingSnapshots().capture(s.task, binding);
  expect(existsSync(marker)).toBe(false);
});

it('captures regular file↔directory refactors as complete deletions and additions', async () => {
  const s = setup();
  mkdirSync(join(s.project, 'parent'));
  writeFileSync(join(s.project, 'parent', 'leaf.txt'), 'old nested\n');
  s.git('add', '.');
  s.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'nested');
  s.task = { ...s.task, baseCommit: s.git('rev-parse', 'HEAD') };
  const binding = await s.worktrees.create(s.task, await s.worktrees.plan(s.task));
  unlinkSync(join(binding.root, 'edit.txt'));
  mkdirSync(join(binding.root, 'edit.txt'));
  writeFileSync(join(binding.root, 'edit.txt', 'child.txt'), 'new nested\n');
  rmSync(join(binding.root, 'parent'), { recursive: true });
  writeFileSync(join(binding.root, 'parent'), 'new flat\n');
  const snapshot = await new GitCodingSnapshots().capture(s.task, binding);
  expect(snapshot.files.map((f) => f.path)).toEqual([
    'edit.txt',
    'edit.txt/child.txt',
    'parent',
    'parent/leaf.txt',
  ]);
  expect(snapshot.files.find((f) => f.path === 'edit.txt')?.after).toBeNull();
  expect(snapshot.files.find((f) => f.path === 'parent/leaf.txt')?.after).toBeNull();
  expect(snapshot.files.find((f) => f.path === 'parent')?.after?.text).toBe('new flat\n');
});

it('preserves UTF-8 BOM bytes consistently in frozen text, hashes and diff', async () => {
  const s = setup();
  writeFileSync(join(s.project, 'bom.txt'), '\ufeffbefore\n');
  s.git('add', '.');
  s.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'bom');
  s.task = { ...s.task, baseCommit: s.git('rev-parse', 'HEAD') };
  const binding = await s.worktrees.create(s.task, await s.worktrees.plan(s.task));
  writeFileSync(join(binding.root, 'bom.txt'), '\ufeffafter\n');
  const snapshot = await new GitCodingSnapshots().capture(s.task, binding),
    change = snapshot.files.find((f) => f.path === 'bom.txt');
  for (const blob of [change?.before, change?.after]) {
    expect(blob?.text.charCodeAt(0)).toBe(0xfeff);
    expect(createHash('sha256').update(Buffer.from(blob!.text, 'utf8')).digest('hex')).toBe(
      blob?.sha256,
    );
  }
});
