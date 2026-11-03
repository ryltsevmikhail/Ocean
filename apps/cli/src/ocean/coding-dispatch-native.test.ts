import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingApprovalBinding, CodingTask } from '@runnets/domain';
import { prepareCodingOperation } from '@runnets/tools-node';
import { CodingApprovalService, dispatchCodingOperation } from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
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

it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['allow-once', 'deny'] as const)(
  'runs a real filesystem effect only after durable %s approval',
  async (decision) => {
    const fixture = await mkdtemp(join(tmpdir(), 'ocean-approved-worker-'));
    const root = join(fixture, 'task');
    const store = openSqliteStore({ path: join(fixture, 'runtime.sqlite') });
    try {
      await mkdir(root);
      await writeFile(join(root, '.git'), 'synthetic');
      const operation = await prepareCodingOperation({
        task: { ...task, worktreeRoot: root },
        scope: binding,
        approvalId: 'approval',
        sandbox: { root },
        snapshot: async () => 'fixture-tree',
        call: {
          id: binding.invocationId,
          name: 'write_file',
          arguments: JSON.stringify({ path: 'new', content: 'approved' }),
        },
      });
      const approvals = new CodingApprovalService({
        store: store.codingApprovals,
        now: () => 100,
        admit: () => true,
        restored: false,
      });
      const result = await dispatchCodingOperation(
        operation,
        approvals,
        {
          decide: async (preview) => {
            expect(store.codingApprovals.atomic((tx) => tx.approval(preview.id)?.status)).toBe(
              'pending',
            );
            expect(preview.preview).toContain('approved');
            expect(store.tools.inspectPending?.()).toEqual([]);
            return decision;
          },
        },
        store.tools,
        new AbortController().signal,
      );
      if (decision === 'allow-once') {
        expect(result.isError).toBe(false);
        expect(await readFile(join(root, 'new'), 'utf8')).toBe('approved');
        expect(store.codingApprovals.atomic((tx) => tx.approval('approval')?.status)).toBe(
          'consumed',
        );
        expect(approvals.consume('approval', operation.binding).ok).toBe(false);
      } else {
        expect(result.isError).toBe(true);
        await expect(readFile(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(store.codingApprovals.atomic((tx) => tx.approval('approval')?.status)).toBe(
          'denied',
        );
      }
      expect(store.tools.inspectPending?.()).toEqual([]);
    } finally {
      store.close();
      await rm(fixture, { recursive: true, force: true });
    }
  },
  12_000,
);
