import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingReviewStatus, LocalDecision } from '@runnets/contracts';
import {
  calls,
  injectEvidence,
  launchOwner,
  launchPeer,
  prepare,
  ref,
  vote,
} from '../../test-fixtures/project-review-fixture.ts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';

type Fixture = Awaited<ReturnType<typeof reserveFixture>>;
type Peer = ReturnType<typeof launchPeer>;
const selectedBytes = 'immutable selected bytes\n';
const source = (f: Fixture) => readFileSync(join(f.project, 'file'), 'utf8');
const journal = (f: Fixture, id: string) => {
  const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT payload FROM ocean_coding_applications WHERE id=?').get(id);
    return row ? JSON.parse(String(row['payload'])) : null;
  } finally {
    db.close();
  }
};
async function approvedReview(f: Fixture, peer: Peer) {
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
const apply = (peer: Peer, input: Input) =>
  peer.call<{ decision: LocalDecision }>('applyCodingChangeset', input);

it('writes the exact approved changes once and reopens the same compact receipt across peers and restart', async () => {
  const f = await reserveFixture();
  try {
    const host = launchOwner(f, 'apply');
    await host.ready;
    const a = launchPeer(f),
      b = launchPeer(f),
      old = launchPeer(f, 'rc2');
    await Promise.all([a.ready, b.ready, old.ready]);
    const { input, later, path, evidence, verdict } = await approvedReview(f, a);
    const [pending, duplicate] = await Promise.all([apply(a, input), apply(b, input)]);
    expect(duplicate).toEqual(pending);
    expect(pending).toMatchObject({
      state: 'pending',
      decision: { status: 'pending' },
      receipt: null,
    });
    const id = pending.decision.decisionId;
    const preview = await b.call<string>('decisionPreview', ref(pending.decision));
    expect(JSON.parse(preview)).toEqual({
      operation: 'apply',
      request: input,
      projectRoot: f.project,
      fileCount: 1,
      verdict: {
        id: verdict.id,
        reviewerBotId: f.input.reviewBotId,
        reviewRoomId: f.input.reviewRoomId,
        verdict: 'approve',
        binding: { ...verdict.binding, testEvidenceHashes: [evidence.hash] },
      },
    });
    expect(preview).not.toMatch(
      /immutable selected bytes|synthetic test evidence|Review of the captured artifact|lease/,
    );
    expect(journal(f, id)).toBeNull();
    expect(source(f)).toBe('base');
    expect(f.git('status', '--porcelain').toString()).toBe('');
    await expect(apply(b, { ...input, changesetHash: later.hash })).rejects.toThrow(
      'request_conflict',
    );
    await expect(apply(b, { ...input, roomId: f.input.reviewRoomId })).rejects.toThrow(
      'coding_denied',
    );
    await expect(apply(b, { ...input, workspaceId: 'other-workspace' })).rejects.toThrow(
      'coding_denied',
    );
    await expect(
      b.call('applyCodingChangeset', { ...input, projectRoot: f.project }),
    ).rejects.toThrow('invalid_params');
    await expect(
      old.call('raw', { method: 'coding.changesets.apply', params: input }),
    ).rejects.toThrow('client_upgrade_required');
    await expect(vote(b, pending.decision, pending.decision.version + 1)).rejects.toThrow(
      'version_conflict',
    );
    await a.call('close');
    await vote(b, pending.decision);
    await expect
      .poll(() => apply(b, input))
      .toMatchObject({
        state: 'completed',
        decision: { status: 'allowed' },
        receipt: { id, status: 'completed', fileCount: 1, completedFiles: 1, uncertainFiles: 0 },
      });
    const completed = await apply(b, input);
    expect(JSON.stringify(completed)).not.toMatch(/"path"|immutable selected bytes/);
    expect(source(f)).toBe(selectedBytes);
    expect(readFileSync(path, 'utf8')).toBe(selectedBytes);
    expect(f.git('rev-parse', 'HEAD').toString().trim()).toBe(input.expectedBase);
    const receipt = journal(f, id);
    expect(receipt).toMatchObject({
      status: 'completed',
      files: [{ path: 'file', status: 'completed' }],
    });
    expect(await b.call('stop')).toMatchObject({ state: 'stopped' });
    await host.kill();
    await launchOwner(f, 'apply').ready;
    const restarted = launchPeer(f);
    await restarted.ready;
    writeFileSync(join(f.project, 'file'), 'subsequent user edit');
    expect(await apply(restarted, input)).toEqual(completed);
    expect(journal(f, id)).toEqual(receipt);
    expect(source(f)).toBe('subsequent user edit');
    expect(calls(f)).toHaveLength(1);
    await expect(apply(restarted, { ...input, expectedBase: 'a'.repeat(40) })).rejects.toThrow(
      'request_conflict',
    );
    await restarted.call('stop');
  } finally {
    await f.close();
  }
}, 20000);

it.each(['evidence', 'verdict', 'worktree', 'source'])(
  'invalidates a pending apply when its %s changes and never writes',
  async (change) => {
    const f = await reserveFixture();
    try {
      await launchOwner(f, 'apply').ready;
      const a = launchPeer(f),
        b = launchPeer(f);
      await Promise.all([a.ready, b.ready]);
      const { input, saved, path } = await approvedReview(f, a);
      await expect(
        apply(a, { ...input, requestId: 'wrong-review', reviewRequestId: 'unknown' }),
      ).rejects.toThrow('coding_denied');
      await expect(
        apply(a, { ...input, requestId: 'wrong-base', expectedBase: 'a'.repeat(40) }),
      ).rejects.toThrow('coding_denied');
      const pending = await apply(a, input);
      if (change === 'evidence') injectEvidence(f, saved, dirname(path), 'changed-evidence');
      if (change === 'verdict') {
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
        try {
          db.prepare(
            "UPDATE ocean_coding_review_verdicts SET payload=json_set(payload,'$.id','replacement') WHERE request_id=?",
          ).run(input.reviewRequestId);
        } finally {
          db.close();
        }
      }
      if (change === 'worktree') writeFileSync(path, 'unreviewed');
      if (change === 'source') writeFileSync(join(f.project, 'file'), 'user work');
      expect(await vote(b, pending.decision)).toMatchObject({ status: 'invalidated' });
      expect(await apply(b, input)).toMatchObject({
        decision: { status: 'invalidated' },
        state: 'no_application',
        receipt: null,
      });
      expect(source(f)).toBe(change === 'source' ? 'user work' : 'base');
      expect(journal(f, pending.decision.decisionId)).toBeNull();
      expect(await b.call('stop')).toMatchObject({ state: 'stopped', outcome: 'complete' });
    } finally {
      await f.close();
    }
  },
  20000,
);

it('recovers a killed file effect as unknown and does not reapply it', async () => {
  const f = await reserveFixture();
  try {
    const host = launchOwner(f, 'apply-crash');
    await host.ready;
    const a = launchPeer(f);
    await a.ready;
    const { input } = await approvedReview(f, a);
    const pending = await apply(a, input);
    await vote(a, pending.decision);
    const id = pending.decision.decisionId;
    await expect.poll(() => existsSync(join(f.directory, 'apply-file-published'))).toBe(true);
    expect(source(f)).toBe(selectedBytes);
    expect(journal(f, id)).toMatchObject({ status: 'applying', files: [{ status: 'started' }] });
    await host.kill();
    await launchOwner(f, 'apply').ready;
    const b = launchPeer(f);
    await b.ready;
    const unknown = await apply(b, input);
    expect(unknown).toMatchObject({
      decision: { status: 'allowed' },
      state: 'outcome_unknown',
      receipt: { id, status: 'uncertain', fileCount: 1, completedFiles: 0, uncertainFiles: 1 },
    });
    expect(journal(f, id)).toMatchObject({ status: 'uncertain', files: [{ status: 'uncertain' }] });
    writeFileSync(join(f.project, 'file'), 'base');
    expect(await apply(b, input)).toEqual(unknown);
    expect(source(f)).toBe('base');
    const old = launchPeer(f, 'rc2');
    await old.ready;
    const inspected = await old.call<{ text: string }>('raw', {
      method: 'coding.inspect-apply',
      params: { workspaceId: input.workspaceId, roomId: input.roomId, id, offset: 0 },
    });
    expect(JSON.parse(inspected.text)).toMatchObject({
      receipt: { status: 'uncertain' },
      holdReleased: false,
    });
  } finally {
    await f.close();
  }
}, 20000);

it('never resumes an allowed request without a receipt or an interrupted owner card', async () => {
  const f = await reserveFixture();
  try {
    const host = launchOwner(f, 'apply-before-claim');
    await host.ready;
    const a = launchPeer(f);
    await a.ready;
    const { input } = await approvedReview(f, a);
    const pending = await apply(a, input);
    const interrupted = { ...input, requestId: 'interrupted-apply' };
    await apply(a, interrupted);
    await host.call('hold');
    await vote(a, pending.decision);
    await expect.poll(() => existsSync(join(f.directory, 'apply-before-claim'))).toBe(true);
    const id = pending.decision.decisionId;
    expect(journal(f, id)).toBeNull();
    expect(source(f)).toBe('base');
    await host.kill();
    await launchOwner(f, 'apply').ready;
    const b = launchPeer(f);
    await b.ready;
    expect(await apply(b, input)).toMatchObject({
      decision: { status: 'allowed' },
      state: 'unconfirmed',
      receipt: null,
    });
    expect(await apply(b, interrupted)).toMatchObject({
      decision: { status: 'interrupted' },
      state: 'no_application',
      receipt: null,
    });
    expect(await b.call('stop')).toMatchObject({ state: 'stopped', outcome: 'complete' });
    expect(journal(f, id)).toBeNull();
    expect(source(f)).toBe('base');
  } finally {
    await f.close();
  }
}, 20000);
