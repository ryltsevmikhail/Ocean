import { expect, it } from 'vitest';
import type { CodingApproval } from '@runnets/domain';
import { TuiApproval } from './approval.js';
import { codingApprovalOwner } from '../ocean/coding-approval.js';
const preview: CodingApproval = {
  id: 'approval',
  preview: 'exact patch\n\x1b[2Jafter',
  status: 'pending',
  createdAt: 100,
  expiresAt: 300100,
  binding: {
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
  },
};
it('offers only allow-once for coding and escapes the exact preview', async () => {
  const ui = new TuiApproval(() => {});
  const result = ui.codingOwner(new AbortController().signal, true).decide(preview);
  const frame = ui.frame({ columns: 100, rows: 40 });
  expect(frame).toContain('exact patch');
  expect(frame).not.toContain('\x1b');
  ui.handle({ type: 'char', value: 'a' });
  expect(ui.frame({ columns: 100, rows: 40 })).not.toBeNull();
  ui.handle({ type: 'char', value: 'y' });
  expect(await result).toBe('allow-once');
});
it('cancels coding confirmation on abort and refuses noninteractive hosts', async () => {
  const ui = new TuiApproval(() => {}),
    controller = new AbortController();
  const result = ui.codingOwner(controller.signal, true).decide(preview);
  controller.abort();
  expect(await result).toBe('cancel');
  expect(await ui.codingOwner(new AbortController().signal, false).decide(preview)).toBe('cancel');
  if (!process.stdin.isTTY)
    expect(await codingApprovalOwner(new AbortController().signal).decide(preview)).toBe('cancel');
});
