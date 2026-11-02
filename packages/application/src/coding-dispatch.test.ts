import { expect, it } from 'vitest';
import type { CodingApproval, CodingApprovalBinding } from '@runnets/domain';
import { CodingApprovalService } from './coding-approval.js';
import { dispatchCodingOperation } from './coding-dispatch.js';
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

it.each(['allow-once', 'deny', 'cancel', 'stale', 'failure'] as const)(
  'dispatches only after exact %s approval and claim',
  async (mode) => {
    const values = new Map<string, CodingApproval>(),
      events: string[] = [];
    const approvals = new CodingApprovalService({
      store: {
        atomic: (work) =>
          work({
            approval: (id) => values.get(id) ?? null,
            putApproval: (value) => {
              values.set(value.id, structuredClone(value));
            },
            claimApprovalOperation: () => {
              events.push('claim');
              return true;
            },
          }),
      },
      now: () => 100,
      admit: () => true,
      restored: false,
    });
    const result = await dispatchCodingOperation(
      {
        approvalId: 'approval',
        binding,
        tool: {
          title: 'write',
          kind: 'edit',
          preview: 'exact patch',
          execute: async () => {
            events.push('execute');
            if (mode === 'failure') throw Error('lost worker');
            return { isError: false, output: 'done' };
          },
        },
        currentBinding: async () =>
          mode === 'stale' ? { ...binding, sourceTreeHash: 'changed' } : binding,
      },
      approvals,
      {
        decide: async () => {
          expect(values.get('approval')?.preview).toBe('exact patch');
          events.push('owner');
          return mode === 'deny' || mode === 'cancel' ? mode : 'allow-once';
        },
      },
      {
        claim: async () => {
          throw Error('must not claim twice');
        },
        settle: async (_id, outcome) => {
          events.push(outcome);
        },
      },
      new AbortController().signal,
    );
    if (mode === 'allow-once') {
      expect(events).toEqual(['owner', 'claim', 'execute', 'completed']);
      expect(result.isError).toBe(false);
    } else if (mode === 'failure') {
      expect(events).toEqual(['owner', 'claim', 'execute', 'uncertain']);
      expect(result.uncertain).toBe(true);
    } else {
      expect(events).toEqual(['owner']);
      expect(result.isError).toBe(true);
    }
  },
);
