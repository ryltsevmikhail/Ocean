import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingReviewStatus, LocalBoundBot } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node';
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

it('enforces cloud transfer policy and invalidates a changed configured reviewer binding', async () => {
  const f = await reserveFixture();
  try {
    const owner = launchOwner(f, 'configured');
    await owner.ready;
    const a = launchPeer(f),
      b = launchPeer(f);
    await Promise.all([a.ready, b.ready]);
    const workspaceId = f.input.workspaceId;
    const binding = { connectionId: 'review-cloud', modelId: 'deepseek-flash' };
    await a.call('setModelConnection', {
      connectionId: binding.connectionId,
      requestId: 'configure',
      expectedRevision: null,
      providerId: 'deepseek',
      kind: 'cloud',
      endpoint: 'https://api.deepseek.com',
      auth: 'api_key',
      defaultModelId: binding.modelId,
      key: 'synthetic-review-credential',
    });
    expect(
      await a.call('checkModelConnection', { connectionId: binding.connectionId }),
    ).toMatchObject({ check: { outcome: 'ok' } });
    const { bot } = await a.call<LocalBoundBot>('createBoundBot', {
      workspaceId,
      requestId: 'cloud-bot',
      handle: 'cloud-review',
      name: 'Cloud reviewer',
      role: 'Fixture',
      binding,
    });
    const room = await a.call<Awaited<ReturnType<LocalRuntimeClient['openDirect']>>>('openDirect', {
      workspaceId,
      requestId: 'cloud-room',
      botId: bot.id,
    });
    f.input.reviewBotId = bot.id;
    f.input.reviewRoomId = room.data.id;
    const { query } = await prepare(f, a);
    const policy = (cloudTransfer: 'deny' | 'allow', expectedRevision: number) =>
      b.call('setRoomModelPolicy', {
        workspaceId,
        roomId: query.roomId,
        requestId: cloudTransfer,
        expectedRevision,
        cloudTransfer,
      });
    // The normal writer guards configured cloud members. Inject a conflicting persisted
    // policy to exercise the review's own transfer check without bypassing it in production.
    await expect(policy('deny', 1)).rejects.toThrow('model_policy_members_conflict');
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
    try {
      db.prepare(
        "UPDATE ocean_room_model_policies SET cloud_transfer='deny', revision=2 WHERE room_id=?",
      ).run(query.roomId);
    } finally {
      db.close();
    }
    await expect(a.call('requestCodingReview', query)).rejects.toThrow('model_transfer_denied');
    expect(calls(f)).toEqual([]);
    await policy('allow', 2);
    const pending = await a.call<CodingReviewStatus>('requestCodingReview', query);
    const preview = await b.call<string>('decisionPreview', ref(pending.decision));
    expect(JSON.parse(preview)).toMatchObject({
      activation: { source: 'connection', kind: 'cloud', ...binding },
    });
    expect(preview).not.toContain('synthetic-review-credential');
    await b.call('setBotModelBinding', {
      workspaceId,
      requestId: 'rotate-reviewer',
      botId: bot.id,
      expectedProfileVersion: bot.profileVersion,
      binding: { ...binding, modelId: 'deepseek-v4-pro' },
    });
    expect(await vote(b, pending.decision)).toMatchObject({ status: 'invalidated' });
    expect(await a.call('requestCodingReview', query)).toMatchObject({
      decision: { status: 'invalidated' },
      state: 'no_review',
      verdict: null,
    });
    expect(calls(f)).toEqual([]);
    const next = { ...query, requestId: 'updated-activation' };
    const allowed = await a.call<CodingReviewStatus>('requestCodingReview', next);
    await vote(b, allowed.decision);
    await expect
      .poll(() => a.call('requestCodingReview', next))
      .toMatchObject({
        state: 'completed',
        verdict: { verdict: 'changes_requested' },
      });
    expect(calls(f)).toMatchObject([{ model: 'deepseek-v4-pro', tools: [] }]);
    await a.call('stop');
  } finally {
    await f.close();
  }
}, 20000);

it.each(['binding', 'evidence'] as const)(
  'refuses changed %s at the provider dispatch seam after owner allowance',
  async (change) => {
    const f = await reserveFixture();
    try {
      const owner = launchOwner(f);
      await owner.ready;
      const a = launchPeer(f),
        b = launchPeer(f);
      await Promise.all([a.ready, b.ready]);
      const { query, path, saved } = await prepare(f, a);
      await owner.call('hold-before-send');
      const pending = await a.call<CodingReviewStatus>('requestCodingReview', query);
      expect(await vote(b, pending.decision)).toMatchObject({ status: 'allowed' });
      await expect.poll(() => existsSync(join(f.directory, 'review-before-send'))).toBe(true);
      if (change === 'evidence') {
        injectEvidence(f, saved, dirname(path), 'late-test');
      } else {
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
        try {
          db.prepare('UPDATE ocean_bot_model_bindings SET model_id=? WHERE bot_id=?').run(
            'changed-at-dispatch',
            f.input.reviewBotId,
          );
        } finally {
          db.close();
        }
      }
      await owner.call('release');
      await expect
        .poll(() => a.call('requestCodingReview', query))
        .toMatchObject({
          decision: { status: 'allowed' },
          state: 'outcome_unknown',
          verdict: null,
          ...(change === 'evidence' ? { stale: true, tests: 'changed' } : {}),
        });
      expect(calls(f)).toEqual([]);
      expect(await a.call('stop')).toMatchObject({
        state: 'stop_incomplete',
        outcome: 'uncertain',
      });
    } finally {
      await f.close();
    }
  },
  20000,
);

it.each(['restore', 'drain'])(
  'refuses review requests on a %s host',
  async (mode) => {
    const f = await reserveFixture();
    try {
      const owner = launchOwner(f, mode);
      await owner.ready;
      const peer = launchPeer(f, 'workspace');
      await peer.ready;
      let stop: Promise<unknown> | undefined;
      if (mode === 'drain') {
        await owner.call('hold');
        stop = owner.call('stop');
        await expect.poll(() => owner.call('status')).toMatchObject({ state: 'draining' });
      }
      await expect(
        peer.call('raw', {
          method: 'coding.reviews.request',
          params: {
            workspaceId: 'ws_ocean',
            roomId: f.input.reviewRoomId,
            taskId: f.input.taskId,
            requestId: 'review',
            hash: 'a'.repeat(64),
          },
        }),
      ).rejects.toThrow(mode === 'restore' ? 'client_upgrade_required' : 'runtime_draining');
      if (stop) {
        await owner.call('release');
        expect(await stop).toMatchObject({ state: 'stopped' });
      }
    } finally {
      await f.close();
    }
  },
  20000,
);
