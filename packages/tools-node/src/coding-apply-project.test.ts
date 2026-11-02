import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import type { CodingTask } from '@runnets/domain';
import { GitCodingApplyProject } from './coding-apply-project.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { GitCodingSnapshots } from './coding-snapshot.js';
it('observes the exact task tree and applies its immutable artifact without staging or committing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-apply-project-'));
  const root = join(directory, 'project');
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    writeFileSync(join(root, 'file'), 'before');
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
    const baseCommit = git('rev-parse', 'HEAD');
    const task: CodingTask = {
      id: 'task',
      workspaceId: 'workspace',
      projectRoot: root,
      baseCommit,
      worktreeRoot: null,
      ownerRoomId: 'room',
      devBotId: 'dev',
      reviewBotId: 'review',
      reviewRoomId: 'review-room',
      status: 'reserved',
      policyVersion: 1,
      policy: {
        version: 1,
        devCapabilities: ['project_read'],
        reviewCapabilities: ['changeset_read'],
        testPresets: [],
      },
      lease: {
        ownerId: 'profile',
        taskId: 'task',
        projectRoot: root,
        requestId: 'request',
        binding: 'binding',
        kind: 'coding',
        token: 'token',
      },
      createdAt: '2026-11-02',
    };
    const worktrees = new GitCodingWorktrees(join(directory, 'worktrees'));
    const binding = await worktrees.create(task, await worktrees.plan(task));
    const bound = { ...task, worktreeRoot: binding.root };
    writeFileSync(join(binding.root, 'file'), 'after');
    const artifact = await new GitCodingSnapshots().capture(bound, binding);
    const project = new GitCodingApplyProject();
    expect(await project.sourceTree(bound)).toBe(artifact.afterTreeHash);
    expect(await project.inspect(root)).toMatchObject({ clean: true, baseCommit });
    await project.applyFile(root, artifact.files[0]!);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('after');
    expect(await project.inspect(root)).toMatchObject({ clean: false, baseCommit });
    expect(git('diff', '--cached')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(baseCommit);
    expect(
      readdirSync(join(root, '.git/ocean-apply-recovery')).some((name) => name.endsWith('.before')),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
