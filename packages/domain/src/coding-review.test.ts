import { expect, it } from 'vitest';
import {
  codingReviewCurrent,
  codingReviewFindingValid,
  type CodingReviewBinding,
} from './coding-review.js';
import type { Changeset } from './changeset.js';
const changeset: Changeset = {
  id: 'c',
  hash: 'hash',
  taskId: 'task',
  baseCommit: 'base',
  beforeTreeHash: 'before',
  afterTreeHash: 'after',
  diff: 'complete',
  files: [
    {
      path: 'source.ts',
      before: null,
      after: { mode: '100644', text: 'seeded defect', sha256: 'blob' },
    },
  ],
};
const binding: CodingReviewBinding = {
  taskId: 'task',
  changesetHash: 'hash',
  baseCommit: 'base',
  afterTreeHash: 'after',
  testEvidenceHashes: ['test'],
};
it('refuses stale artifact tree base and test identities', () => {
  expect(codingReviewCurrent(binding, changeset, ['test'])).toBe(true);
  for (const patch of [
    { changesetHash: 'new' },
    { afterTreeHash: 'new' },
    { baseCommit: 'new' },
    { taskId: 'other' },
  ])
    expect(codingReviewCurrent({ ...binding, ...patch }, changeset, ['test'])).toBe(false);
  expect(codingReviewCurrent(binding, changeset, ['new test'])).toBe(false);
});
it('validates findings against immutable artifact lines', () => {
  const finding = {
    path: 'source.ts',
    side: 'after' as const,
    line: 1,
    severity: 'important' as const,
    explanation: 'seeded defect',
  };
  expect(codingReviewFindingValid(finding, changeset)).toBe(true);
  expect(codingReviewFindingValid({ ...finding, line: 2 }, changeset)).toBe(false);
  expect(codingReviewFindingValid({ ...finding, side: 'before' }, changeset)).toBe(false);
  expect(codingReviewFindingValid({ ...finding, path: 'private-chat.txt' }, changeset)).toBe(false);
});
