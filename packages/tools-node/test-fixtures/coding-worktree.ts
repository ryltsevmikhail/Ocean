import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CodingTask } from '@runnets/domain';
import { GitCodingWorktrees } from '@runnets/tools-node';
export function codingWorktreeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-worktree-'));
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
