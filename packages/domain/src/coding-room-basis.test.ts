import { expect, it } from 'vitest';
import { validCodingGrantBasis } from './coding-approval.js';
const debit = {
  chargedRunId: 'run',
  grantId: 'grant',
  revision: 1,
  subject: { workspaceId: 'ws', roomId: 'room', botId: 'bot', projectId: null, taskId: null },
};
it('requires bounded exact primitive debit tuples without reordered duplicates', () => {
  expect(validCodingGrantBasis([debit])).toBe(true);
  for (const value of [
    [{ ...debit, revision: [1] }],
    [{ ...debit, chargedRunId: ['run'] }],
    [{ ...debit, subject: { ...debit.subject, botId: ['bot'] } }],
    [
      debit,
      {
        ...debit,
        subject: { taskId: null, projectId: null, botId: 'bot', roomId: 'room', workspaceId: 'ws' },
      },
    ],
    [{ ...debit, [Symbol('extra')]: true }],
    Array(1),
    Array(1025).fill(debit),
  ])
    expect(validCodingGrantBasis(value)).toBe(false);
});
