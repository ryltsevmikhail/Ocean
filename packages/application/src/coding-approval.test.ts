import { expect, it } from 'vitest';
import type { CodingApproval, CodingApprovalBinding } from '@runnets/domain';
import { CodingApprovalService } from './coding-approval.js';
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
it('persists preview before prompting and rechecks expiry after the owner returns', async () => {
  const values = new Map<string, CodingApproval>();
  let now = 100;
  const service = new CodingApprovalService({
    store: {
      atomic: (work) =>
        work({
          claimApprovalOperation: () => true,
          approval: (id) => structuredClone(values.get(id) ?? null),
          putApproval: (value) => {
            values.set(value.id, structuredClone(value));
          },
        }),
    },
    now: () => now,
    admit: () => true,
    restored: false,
  });
  expect(service.request('approval', binding, 'exact patch').ok).toBe(true);
  const result = await service.decide('approval', binding, {
    decide: async (preview) => {
      expect(values.get(preview.id)?.preview).toBe('exact patch');
      now = 300100;
      return 'allow-once';
    },
  });
  expect(result).toMatchObject({ ok: false });
  expect(values.get('approval')?.status).toBe('pending');
});
it('refuses restored admission before persisting a preview', () => {
  const service = new CodingApprovalService({
    store: {
      atomic: () => {
        throw Error('must not persist');
      },
    },
    now: () => 100,
    admit: () => true,
    restored: true,
  });
  expect(service.request('approval', binding, 'patch')).toMatchObject({ ok: false });
});

it.each(['allow-once', 'deny', 'cancel'] as const)(
  'consumes %s at most once with a dispatch claim',
  async (decision) => {
    const values = new Map<string, CodingApproval>();
    let claims = 0;
    const service = new CodingApprovalService({
      store: {
        atomic: (work) =>
          work({
            approval: (id) => structuredClone(values.get(id) ?? null),
            putApproval: (value) => {
              values.set(value.id, structuredClone(value));
            },
            claimApprovalOperation: () => {
              claims++;
              return true;
            },
          }),
      },
      now: () => 100,
      admit: () => true,
      restored: false,
    });
    service.request('approval', binding, 'patch');
    await service.decide('approval', binding, { decide: async () => decision });
    expect(service.consume('approval', { ...binding, roomId: 'foreign' }).ok).toBe(false);
    expect(claims).toBe(0);
    expect(service.consume('approval', binding).ok).toBe(decision === 'allow-once');
    expect(service.consume('approval', binding).ok).toBe(false);
    expect(claims).toBe(decision === 'allow-once' ? 1 : 0);
  },
);
