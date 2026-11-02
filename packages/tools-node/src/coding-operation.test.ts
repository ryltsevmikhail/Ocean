import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingApprovalBinding, CodingTask } from '@runnets/domain';
import { prepareCodingOperation } from './coding-operation.js';
const binding: CodingApprovalBinding = {
  workspaceId: 'w',
  taskId: 't',
  projectRoot: '/p',
  worktreeRoot: '/wt',
  roomId: 'r',
  botId: 'b',
  runId: 'run',
  attemptId: 'a',
  invocationId: 'i',
  operation: 'write',
  operationHash: 'patch',
  sourceTreeHash: 'tree',
  policyVersion: 1,
  limitsHash: 'limits',
  toolchainHash: 'tools',
};
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

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'prepares an exact new-file operation without dispatching it',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-operation-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      const prepared = await prepareCodingOperation({
        task: { ...task, worktreeRoot: root },
        scope: binding,
        approvalId: 'approval',
        sandbox: { root },
        snapshot: async () => 'tree',
        call: {
          id: binding.invocationId,
          name: 'write_file',
          arguments: JSON.stringify({ path: 'new', content: 'after' }),
        },
      });
      expect(prepared.binding).toMatchObject({
        taskId: 't',
        worktreeRoot: root,
        operation: 'write',
        sourceTreeHash: 'tree',
      });
      expect(prepared.tool.preview).toContain('after');
      await expect(readFile(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(prepared.binding.operationHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
