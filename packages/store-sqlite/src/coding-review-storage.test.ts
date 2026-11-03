import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingReviewRequest, CodingReviewVerdict } from '@runnets/domain';
import { openSqliteStore } from './index.js';
it('atomically persists immutable handoff and one verdict across reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-review-store-')),
    path = join(root, 'fixture.sqlite');
  const request: CodingReviewRequest = {
    id: 'request',
    workspaceId: 'ws',
    reviewRoomId: 'room',
    reviewerBotId: 'review',
    binding: {
      taskId: 'task',
      changesetHash: 'hash',
      baseCommit: 'base',
      afterTreeHash: 'tree',
      testEvidenceHashes: ['test'],
    },
    contextGrant: [],
    status: 'requested',
  };
  const verdict: CodingReviewVerdict = {
    id: 'verdict',
    binding: request.binding,
    reviewerBotId: 'review',
    reviewRoomId: 'room',
    verdict: 'changes_requested',
    findings: [],
    summary: 'Need repair',
  };
  try {
    const store = openSqliteStore({ path });
    try {
      store.codingReviews.atomic((tx) => tx.putReviewRequest(request));
      expect(() =>
        store.codingReviews.atomic((tx) => {
          tx.putReviewVerdict(request.id, verdict);
          tx.putReviewRequest({ ...request, status: 'completed' });
          throw Error('crash');
        }),
      ).toThrow('crash');
      expect(store.codingReviews.atomic((tx) => tx.reviewVerdict(request.id))).toBeNull();
      store.codingReviews.atomic((tx) => {
        tx.putReviewVerdict(request.id, verdict);
        tx.putReviewRequest({ ...request, status: 'completed' });
      });
      expect(() =>
        store.codingReviews.atomic((tx) =>
          tx.putReviewRequest({ ...request, contextGrant: ['changed'] }),
        ),
      ).toThrow('immutable');
      expect(() =>
        store.codingReviews.atomic((tx) => tx.putReviewVerdict(request.id, verdict)),
      ).toThrow();
    } finally {
      store.close();
    }
    const reopened = openSqliteStore({ path });
    try {
      expect(reopened.codingReviews.atomic((tx) => tx.reviewVerdict(request.id))).toEqual(verdict);
      expect(reopened.codingReviews.atomic((tx) => tx.reviewRequest(request.id)?.status)).toBe(
        'completed',
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
