import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  OwnerScopeService,
  CodingApprovalService,
  codingApprovalAdmission,
  dispatchCodingOperation,
} from '@runnets/application';
import { claimFixture, hash } from '../test-fixtures/finalization-claims.js';
it.each([
  'write',
  'test',
  'revoke',
  'before-consume',
  'changed-source',
  'lease',
  'other-attempt',
  'wrong-fingerprint',
] as const)('consumes an exact %s owner grant and guards worker dispatch', async (mode) => {
  const f = claimFixture();
  try {
    const owners = new OwnerScopeService(f.store.serviceAuthority, 'owner', () => 100);
    const projectId = createHash('sha256').update('/project').digest('hex');
    const grant = owners.issue({
      id: 'g',
      subject: { workspaceId: 'ws', roomId: 'room', botId: 'dev', projectId, taskId: 'task' },
      permissions: [
        {
          kind: 'coding',
          actions: ['propose_write', 'run_test_preset'],
          resources: [{ kind: 'project-worktree', projectId, worktreeId: 'task' }],
        },
      ],
      limits: { maxCalls: 1, maxEffectBytes: 4096, expiresAt: null },
    });
    let prompts = 0,
      sends = 0;
    let owns = true,
      currentReads = 0;
    const approvals = new CodingApprovalService({
      store: f.store.codingApprovals,
      grantOwnerId: 'owner',
      restored: false,
      now: () => 100,
      admit: (b, tx, own) =>
        codingApprovalAdmission(
          b,
          tx,
          {
            ownerId: 'owner',
            journal: f.store.tools,
            leases: {
              owns: () => owns,
              acquire: () => {
                throw Error('unused');
              },
              release: () => false,
            },
          },
          own,
        ),
    });
    const op = mode === 'test' ? 'test' : 'write';
    const { id, binding } = f.operation(op);
    const result = await dispatchCodingOperation(
      {
        approvalId: id,
        binding,
        currentBinding: async () => {
          currentReads++;
          if (mode === 'before-consume' && currentReads === 2)
            owners.revoke({ grantId: 'g', revision: 1 });
          if (mode === 'changed-source' && currentReads === 2)
            return { ...binding, sourceTreeHash: '7'.repeat(64) };
          return binding;
        },
        guarded: true,
        ...(op === 'test'
          ? {
              recordResult: () => {
                const body = {
                  presetId: 'test',
                  id,
                  binding,
                  invocationHash: '5'.repeat(64),
                  beforeTreeHash: binding.sourceTreeHash,
                  afterTreeHash: binding.sourceTreeHash,
                  dependencyHash: '6'.repeat(64),
                  dependenciesUnchanged: true,
                  exitCode: 0,
                  reason: 'exit' as const,
                  cleanupConfirmed: true,
                  truncated: false,
                  output: 'result',
                };
                f.store.codingEvidence.put({ ...body, hash: hash(body) });
              },
            }
          : {}),
        tool: {
          title: 'test',
          preview:
            op === 'test'
              ? JSON.stringify({ program: '/toolchain/node', args: ['test.cjs'], cwd: '.' })
              : 'prepared',
          kind: op === 'test' ? 'execute' : 'edit',
          execute: async (_signal, guard) => {
            if (mode === 'other-attempt')
              f.db
                .prepare(
                  `INSERT INTO tool_invocations_v2(id,tool,task_run_id,attempt_id,fingerprint,outcome,admission)
                SELECT id,tool,task_run_id,'different-attempt','different-fingerprint','started',json_set(admission,'$.grantReference',NULL) FROM tool_invocations_v2 WHERE id=?`,
                )
                .run(binding.invocationId);
            if (mode === 'wrong-fingerprint')
              f.db
                .prepare("UPDATE tool_invocations_v2 SET fingerprint='different' WHERE id=?")
                .run(binding.invocationId);
            if (mode === 'lease') owns = false;
            if (mode === 'revoke') owners.revoke({ grantId: grant.id, revision: 1 });
            if (!guard?.authorize()) throw Error('worker dispatch refused');
            sends++;
            return { output: 'result', isError: false };
          },
        },
      },
      approvals,
      {
        decide: async () => {
          prompts++;
          return 'deny';
        },
      },
      f.store.tools,
      new AbortController().signal,
    );
    expect(prompts).toBe(0);
    const refused = mode !== 'write' && mode !== 'test';
    expect(sends).toBe(refused ? 0 : 1);
    expect(result.isError).toBe(refused);
    if (mode === 'before-consume' || mode === 'changed-source') {
      expect(f.approval(id).status).toBe('allowed');
      expect(f.rows()['tool_invocations_v2']).toEqual([]);
      return;
    }
    expect(f.approval(id)).toMatchObject({
      status: 'consumed',
      grantReference: { grantId: 'g', revision: 1 },
    });
    expect(f.rows()['tool_invocations_v2']?.[0]?.['outcome']).toBe(
      refused ? 'not_started' : 'completed',
    );
    const holds = f.holds().filter((h) => h.kind === 'claim');
    if (mode === 'wrong-fingerprint') expect(holds.length).toBeGreaterThan(0);
    else expect(holds).toEqual([]);
  } finally {
    f.close();
  }
});
