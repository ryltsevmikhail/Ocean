import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingReviewStatus } from '@runnets/contracts';
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

it('approves one exact immutable review across peers and reopens the recorded verdict', async () => {
  const f = await reserveFixture();
  try {
    const host = launchOwner(f);
    await host.ready;
    const a = launchPeer(f),
      b = launchPeer(f),
      old = launchPeer(f, 'rc2');
    await Promise.all([a.ready, b.ready, old.ready]);
    const { query, saved, later, path } = await prepare(f, a);
    const evidence = injectEvidence(f, later, dirname(path), 'other-tree');
    const request = (peer: typeof a, q = query) =>
      peer.call<CodingReviewStatus>('requestCodingReview', q);
    const [pending, duplicate] = await Promise.all([request(a), request(b)]);
    expect(pending).toMatchObject({
      state: 'pending',
      stale: false,
      tests: 'different_snapshot',
      verdict: null,
    });
    expect(duplicate).toEqual(pending);
    expect(calls(f)).toEqual([]);
    const preview = await b.call<string>('decisionPreview', ref(pending.decision));
    expect(JSON.parse(preview)).toMatchObject({
      operation: 'review',
      request: query,
      binding: {
        taskId: query.taskId,
        changesetHash: saved.hash,
        baseCommit: saved.baseCommit,
        afterTreeHash: saved.afterTreeHash,
        testEvidenceHashes: [evidence.hash],
      },
      reviewerBotId: f.input.reviewBotId,
      activation: { providerId: 'fixture', modelId: 'fixture' },
    });
    expect(preview).not.toMatch(
      /immutable selected bytes|later mutable bytes|synthetic test evidence|lease|credential/,
    );
    await expect(request(b, { ...query, hash: later.hash })).rejects.toThrow('request_conflict');
    await expect(vote(b, pending.decision, pending.decision.version + 1)).rejects.toThrow(
      'version_conflict',
    );
    await expect(
      old.call('raw', { method: 'coding.reviews.request', params: query }),
    ).rejects.toThrow('client_upgrade_required');
    await expect(
      old.call('raw', { method: 'decisions.get', params: ref(pending.decision) }),
    ).rejects.toThrow('client_upgrade_required');
    await expect(b.call('requestCodingReview', { ...query, model: 'fallback' })).rejects.toThrow(
      'invalid_params',
    );
    await expect(request(b, { ...query, roomId: f.input.ownerRoomId })).rejects.toThrow(
      'coding_denied',
    );
    expect(
      await old.call('raw', {
        method: 'coding.diff',
        params: {
          workspaceId: query.workspaceId,
          roomId: f.input.ownerRoomId,
          id: query.taskId,
          offset: 0,
        },
      }),
    ).toMatchObject({ text: expect.stringContaining('later mutable bytes') });
    await a.call('close');
    await vote(b, pending.decision);
    await expect
      .poll(() => request(b))
      .toMatchObject({
        state: 'completed',
        stale: false,
        tests: 'different_snapshot',
        decision: { status: 'allowed' },
        verdict: { verdict: 'changes_requested', summary: 'Review of the captured artifact' },
      });
    const completed = await request(b);
    expect(calls(f)).toHaveLength(1);
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
    try {
      const ledger = db
        .prepare(
          "SELECT type,payload FROM events WHERE type IN ('attempt.model_request_started','attempt.model_request_settled') ORDER BY sequence",
        )
        .all()
        .map((row) => ({ type: row['type'], payload: JSON.parse(String(row['payload'])) }));
      expect(ledger).toMatchObject([
        {
          type: 'attempt.model_request_started',
          payload: { activation: { limits: { maxModelRequests: 1 } } },
        },
        {
          type: 'attempt.model_request_settled',
          payload: { usage: { kind: 'actual', tokens: { totalTokens: 30 } } },
        },
      ]);
    } finally {
      db.close();
    }
    const [call] = calls(f);
    expect(call!.tools).toEqual([]);
    expect(call!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    const artifact = JSON.parse(call!.messages[1]!.content);
    expect(artifact.changeset).toMatchObject({
      hash: saved.hash,
      files: [
        { path: 'file', before: { text: 'base' }, after: { text: 'immutable selected bytes\n' } },
      ],
    });
    expect(Object.keys(artifact)).toEqual(['request', 'changeset', 'evidence']);
    expect(artifact.request.contextGrant).toEqual([]);
    expect(artifact.evidence).toEqual([evidence]);
    expect(readFileSync(path, 'utf8')).toBe('later mutable bytes\n');
    expect(readFileSync(join(f.project, 'file'), 'utf8')).toBe('base');
    expect(f.git('status', '--porcelain').toString()).toBe('');
    expect(f.git('rev-parse', 'HEAD').toString().trim()).toBe(saved.baseCommit);
    await b.call('stop');
    await host.kill();
    await launchOwner(f).ready;
    const c = launchPeer(f);
    await c.ready;
    expect(await request(c)).toEqual(completed);
    injectEvidence(f, saved, dirname(path), 'selected-tree');
    expect(await request(c)).toEqual({ ...completed, stale: true, tests: 'changed' });
    expect(calls(f)).toHaveLength(1);
    await c.call('stop');
  } finally {
    await f.close();
  }
}, 20000);

it('a marked review with no verdict reopens as outcome unknown and never calls again', async () => {
  const f = await reserveFixture();
  try {
    const host = launchOwner(f);
    await host.ready;
    const peer = launchPeer(f);
    await peer.ready;
    const { query } = await prepare(f, peer);
    await host.call('hold');
    const { decision } = await peer.call<CodingReviewStatus>('requestCodingReview', query);
    await vote(peer, decision);
    await expect.poll(() => calls(f).length).toBe(1);
    const waiting = { ...query, requestId: 'waiting-on-owner' };
    const pending = await peer.call<CodingReviewStatus>('requestCodingReview', waiting);
    await host.kill();
    await launchOwner(f).ready;
    const restarted = launchPeer(f);
    await restarted.ready;
    const request = () => restarted.call('requestCodingReview', query);
    const unknown = await request();
    expect(unknown).toMatchObject({
      state: 'outcome_unknown',
      verdict: null,
      decision: { status: 'allowed' },
    });
    expect(await request()).toEqual(unknown);
    expect(await restarted.call('requestCodingReview', waiting)).toMatchObject({
      state: 'no_review',
      decision: { status: 'interrupted' },
      verdict: null,
    });
    await expect(vote(restarted, pending.decision)).rejects.toThrow('version_conflict');
    expect(calls(f)).toHaveLength(1);
    await restarted.call('stop');
  } finally {
    await f.close();
  }
}, 20000);

it('joins an active review on stop and persists uncertainty without claiming cancellation', async () => {
  const f = await reserveFixture();
  try {
    const host = launchOwner(f);
    await host.ready;
    const peer = launchPeer(f);
    await peer.ready;
    const { query } = await prepare(f, peer);
    await host.call('hold');
    const { decision } = await peer.call<CodingReviewStatus>('requestCodingReview', query);
    await vote(peer, decision);
    await expect.poll(() => calls(f).length).toBe(1);
    const stopping = host.call('stop');
    await expect.poll(() => host.call('status')).toMatchObject({ state: 'draining' });
    // Keep the adapter inside its iterator until shutdown has begun.
    await host.call('release');
    expect(await stopping).toMatchObject({ state: 'stop_incomplete', outcome: 'uncertain' });
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT payload FROM ocean_coding_review_requests WHERE id=?')
        .get(decision.decisionId);
      expect(JSON.parse(String(row?.['payload']))).toMatchObject({ status: 'uncertain' });
      expect(
        db
          .prepare('SELECT id FROM ocean_coding_review_verdicts WHERE request_id=?')
          .get(decision.decisionId),
      ).toBeUndefined();
    } finally {
      db.close();
    }
    expect(calls(f)).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 20000);
