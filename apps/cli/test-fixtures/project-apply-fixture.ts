import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import type { CodingReviewStatus, LocalDecision } from '@runnets/contracts';
import { injectEvidence, prepare, vote, type launchPeer } from './project-review-fixture.ts';
import type { reserveFixture } from './project-reserve-fixture.ts';

type Fixture = Awaited<ReturnType<typeof reserveFixture>>;
type Peer = ReturnType<typeof launchPeer>;
export const selectedBytes = 'immutable selected bytes\n';
export const source = (f: Fixture) => readFileSync(join(f.project, 'file'), 'utf8');
export const journal = (f: Fixture, id: string) => {
  const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT payload FROM ocean_coding_applications WHERE id=?').get(id);
    return row ? JSON.parse(String(row['payload'])) : null;
  } finally {
    db.close();
  }
};
export async function approvedReview(f: Fixture, peer: Peer) {
  const { query, saved, later, path } = await prepare(f, peer);
  writeFileSync(path, selectedBytes);
  const evidence = injectEvidence(f, saved, dirname(path), 'selected-tree');
  const review = () => peer.call<CodingReviewStatus>('requestCodingReview', query);
  const { decision } = await review();
  await vote(peer, decision);
  await expect.poll(review).toMatchObject({
    state: 'completed',
    tests: 'matches_snapshot',
    verdict: { verdict: 'approve' },
  });
  return {
    path,
    saved,
    later,
    evidence,
    verdict: (await review()).verdict!,
    input: {
      workspaceId: query.workspaceId,
      roomId: f.input.ownerRoomId,
      taskId: query.taskId,
      requestId: 'apply',
      expectedBase: saved.baseCommit,
      changesetHash: saved.hash,
      reviewRequestId: decision.decisionId,
    },
  };
}
type Input = Awaited<ReturnType<typeof approvedReview>>['input'];
export const apply = (peer: Peer, input: Input) =>
  peer.call<{ decision: LocalDecision }>('applyCodingChangeset', input);
