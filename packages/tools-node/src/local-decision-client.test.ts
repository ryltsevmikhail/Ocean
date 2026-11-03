import { expect, it } from 'vitest';
import { localDecisionClient } from './local-decision-client.js';
it('rejects hidden, substituted or widened decision requests before sending any frames', async () => {
  let frames = 0;
  const c = localDecisionClient(async () => {
    frames++;
    throw Error('unexpected wire');
  });
  const scope = { workspaceId: 'w', roomId: 'r' },
    ref = { ...scope, runId: 'run', decisionId: 'id' };
  const q = {
    ...ref,
    expectedVersion: 1,
    bindingDigest: 'a'.repeat(64),
    choice: 'allow-once' as const,
  };
  const results = await Promise.allSettled([
    c.decisionPreview(Object.assign([], ref)),
    c.resolveDecision(Object.assign({ owner: true }, q)),
    c.getDecision(Object.defineProperty({ ...ref }, 'toJSON', { value: () => ref })),
    c.getDecision(Object.assign(Object.create({ toJSON: () => ref }), ref)),
    c.listDecisions({ ...scope, limit: 201 }),
    c.reviewRoom({ ...scope, runId: 'other' } as typeof scope),
    c.requestContinuation({ ...ref, requestId: 'q', reviewVersion: 'x', reason: 'OK' }),
    ...['🚀'.repeat(600), 'invalid\u0000reason', '\ud800'].map((reason) =>
      c.requestContinuation({
        ...scope,
        runId: 'run',
        requestId: 'q',
        reviewVersion: 'a'.repeat(64),
        reason,
      }),
    ),
  ]);
  expect(frames).toBe(0);
  expect(
    results.every((r) => r.status === 'rejected' && r.reason.message === 'invalid_params'),
  ).toBe(true);
});
