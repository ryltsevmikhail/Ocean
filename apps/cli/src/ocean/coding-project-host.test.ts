import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingTask } from '@runnets/domain';
import { registerCodingProject } from './coding-projects.js';
import { registeredCodingTools } from './coding-project-host.js';
const task: CodingTask = {
  id: 't',
  workspaceId: 'w',
  projectRoot: '/p',
  worktreeRoot: '/wt',
  baseCommit: 'base',
  ownerRoomId: 'r',
  devBotId: 'b',
  reviewBotId: 'review',
  reviewRoomId: 'review-room',
  status: 'reserved',
  policyVersion: 1,
  policy: {
    version: 1,
    devCapabilities: ['propose_write'],
    reviewCapabilities: ['changeset_read'],
    testPresets: [],
  },
  lease: {
    ownerId: 'owner',
    taskId: 't',
    requestId: 'request',
    binding: 'binding',
    kind: 'coding',
    projectRoot: '/p',
    token: 'token',
  },
  createdAt: '2026-11-02',
};

it('resolves registered mounts only for matching task policy and prepares dependency destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocean-project-host-'));
  try {
    const worktree = join(root, 'task');
    await mkdir(worktree);
    await mkdir(join(root, 'node_modules'));
    await registerCodingProject(
      root,
      {
        id: 'project',
        root,
        testPresets: [],
        dependencyProjectRoot: root,
        mounts: [{ source: join(root, 'node_modules'), target: '/workspace/node_modules' }],
      },
      async () => true,
    );
    const host = registeredCodingTools(root),
      bound = { ...task, projectRoot: root, worktreeRoot: worktree };
    expect(await host.sandbox(bound)).toMatchObject({
      root: worktree,
      dependencyProjectRoot: root,
    });
    expect((await stat(join(worktree, 'node_modules'))).isDirectory()).toBe(true);
    await expect(
      host.sandbox({
        ...bound,
        policy: {
          ...bound.policy,
          testPresets: [{ id: 'other', program: '/node', args: [], cwd: '.' }],
        },
      }),
    ).rejects.toThrow('policy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
