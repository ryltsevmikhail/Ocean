import { DatabaseSync } from 'node:sqlite';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import { digest } from './decision-preview.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';
import { RuntimeDecisions } from './decisions.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import type { ProviderPort } from '@runnets/application';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'ocean-decision-conflict-'));
  const r = openOceanProfile(path, true);
  await r.ready;
  const { workspaceId, roomId, groupId } = rooms(r.conversations);
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream() {
      yield { type: 'text_delta', text: 'partial' };
    },
  };
  const d = new RuntimeDecisions(r.ownerDecisions, r.reviews);
  const held = async (roomId: string, requestId: string) => {
    await r.chat.send({
      workspaceId,
      roomId,
      requestId,
      to: 'dev',
      provider,
      text: 'held',
      signal: new AbortController().signal,
      emit: () => {},
    });
    const { view } = await d.reviews.read({ workspaceId, roomId });
    return {
      workspaceId,
      roomId,
      runId: view.runId,
      reviewVersion: view.version,
      reason: 'owner reason',
      requestId: 'continue',
    };
  };
  const one = await held(roomId, 'send-first'),
    two = await held(groupId, 'send-second');
  return {
    one,
    two,
    r,
    d,
    path,
    close: async () => {
      await d.drain();
      r.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

it.each(['submit', 'room-receipt', 'other-room', 'changed-run', 'reverse'])(
  'rejects %s global key reuse without a new card or competing receipt',
  async (variant) => {
    const { one, two, r, d, close } = await fixture();
    try {
      if (variant === 'submit' || variant === 'room-receipt') {
        const requestId = variant === 'submit' ? 'send-first' : 'direct';
        expect(await d.dispatch('reviews.continue', { ...one, requestId })).toEqual({
          error: { code: 'request_conflict' },
        });
        expect(r.ownerDecisions.list(one, '', 50)).toEqual([]);
        return;
      }
      const [a, b] = await Promise.all([d.reviews.request(one), d.reviews.request(one)]);
      expect(a).toEqual(b);
      if (variant === 'reverse') {
        const res = r.chat.submit({
          workspaceId: one.workspaceId,
          roomId: two.roomId,
          requestId: one.requestId,
          provider: null,
          text: 'other',
          signal: new AbortController().signal,
          emit: () => {},
        });
        expect(res).toMatchObject({ ok: false, error: { code: 'request_conflict' } });
      } else {
        const wrong = variant === 'other-room' ? two : { ...one, runId: two.runId };
        expect(await d.dispatch('reviews.continue', wrong)).toEqual({
          error: { code: 'request_conflict' },
        });
      }
      expect(r.ownerDecisions.list(one, '', 50)).toEqual([a]);
      expect(r.ownerDecisions.list(two, '', 50)).toEqual([]);
    } finally {
      await close();
    }
  },
);
it('two simultaneous replies return the committed winner when global evidence changes AFTER owner CAS', async () => {
  const { one, r, d, close } = await fixture();
  try {
    const card = await d.reviews.request(one);
    const settle = r.ownerDecisions.settle.bind(r.ownerDecisions);
    let claim: Promise<boolean> | undefined;
    r.ownerDecisions.settle = (expected, outcome) => {
      const won = settle(expected, outcome);
      if (won && outcome === 'allowed')
        claim = r.toolJournal!.claim(
          'new-effect',
          'command',
          { taskRunId: one.runId, attemptId: 'new' },
          'proof',
        );
      return won;
    };
    const { workspaceId, roomId, runId, decisionId, bindingDigest } = card;
    const q = {
      workspaceId,
      roomId,
      runId,
      decisionId,
      bindingDigest,
      expectedVersion: 1,
      choice: 'allow-once',
    };
    const replies = await Promise.all([
      d.dispatch('decisions.resolve', q),
      d.dispatch('decisions.resolve', q),
    ]);
    expect(await claim).toBe(true);
    expect(replies).toEqual(
      [0, 1].map(() => ({ result: { ...card, status: 'allowed', version: 2 } })),
    );
    await d.drain();
    expect(d.reviews.applied(card)).toBe(false);
    expect(r.reviews.receipt(workspaceId, roomId, runId, one.requestId)).toBeNull();
    expect(r.conversations.history(workspaceId, roomId)).toMatchObject({
      value: [{ body: 'held' }],
    });
  } finally {
    await close();
  }
});

it('protects an 81c5ec7 review key with no reservation across reopen without applying its old vote', async () => {
  const { one, two, r, d, path, close } = await fixture();
  try {
    const requestId = 'legacy',
      decisionId = 'review-' + digest(JSON.stringify([one.workspaceId, requestId]));
    const { view } = await d.reviews.read(one);
    const preview = JSON.stringify({
      mode: 'text_only',
      snapshot: view,
      requestId,
      reason: one.reason,
    });
    const createdAt = Date.now(),
      old = {
        workspaceId: one.workspaceId,
        roomId: one.roomId,
        runId: one.runId,
        decisionId,
        kind: 'continue-text-only' as const,
        version: 1,
        status: 'pending' as const,
        bindingDigest: digest(preview),
        previewLength: preview.length,
        createdAt,
        expiresAt: createdAt + 300000,
      };
    r.ownerDecisions.insert(old, preview);
    r.ownerDecisions.settle(old, 'allowed');
    await d.drain();
    r.close();
    for (let i = 0; i < 2; i++) {
      const next = openOceanProfile(path);
      await next.ready;
      try {
        const wrong = next.conversations.execute({
          type: 'RecordUserMessage',
          requestId,
          workspaceId: one.workspaceId,
          roomId: two.roomId,
          text: 'new',
        });
        expect(wrong).toMatchObject({ ok: false, error: { code: 'request_conflict' } });
        const owner = new RuntimeDecisions(next.ownerDecisions, next.reviews);
        expect(await owner.reviews.request({ ...one, requestId })).toMatchObject({
          decisionId,
          status: 'allowed',
          version: 2,
        });
        expect(owner.reviews.applied(old)).toBe(false);
        expect(next.reviews.receipt(one.workspaceId, one.roomId, one.runId, requestId)).toBeNull();
        await owner.drain();
      } finally {
        next.close();
      }
    }
  } finally {
    await close();
  }
});
it('rolls a review reservation and card back together before installing a waiter', async () => {
  const { one, r, d, close } = await fixture();
  try {
    const insert = r.ownerDecisions.insert.bind(r.ownerDecisions);
    r.ownerDecisions.insert = (card, preview) => {
      insert(card, preview);
      throw Error('fault before reservation commit');
    };
    await expect(d.reviews.request(one)).rejects.toThrow('fault before reservation commit');
    expect(r.ownerDecisions.list(one, '', 50)).toEqual([]);
    expect(r.reviews.hasRequest(one.requestId)).toBe(false);
    r.ownerDecisions.insert = insert;
    expect(await d.reviews.request(one)).toMatchObject({ status: 'pending', version: 1 });
  } finally {
    await close();
  }
});

it('independent SDK clients read the same winning vote after an intervening journal conflict', async () => {
  const { one, r, path, close } = await fixture(),
    runDir = join(path, 'run');
  r.close();
  mkdirSync(runDir, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', runDir);
  const db = new DatabaseSync(join(path, 'runtime.sqlite'));
  db.exec(`CREATE TRIGGER evidence_at_vote AFTER UPDATE OF status ON ocean_owner_decisions WHEN new.status='allowed' BEGIN
 INSERT INTO tool_invocations_v2 VALUES('fixture','private-tool','tr_foreign','fixture','fixture','started');END`);
  db.close();
  const host = await startLocalRuntime({ profile: path, provider: null });
  const client = await connectLocalRuntime({ profile: path });
  try {
    const card = await client.requestContinuation(one);
    const { workspaceId, roomId, runId, decisionId, bindingDigest } = card;
    const ref = { workspaceId, roomId, runId, decisionId },
      cas = { ...ref, bindingDigest, choice: 'allow-once', expectedVersion: 1 };
    const peer = decisionPeer(path, runDir);
    const [a, b] = await Promise.all([peer('resolveDecision', cas), peer('resolveDecision', cas)]);
    expect(a).toEqual({ ...card, version: 2, status: 'allowed' });
    expect(b).toEqual(a);
    expect(await client.continuationApplied(ref)).toBe(false);
    expect(await client.history({ workspaceId, roomId })).toHaveLength(1);
    expect((await client.getRun({ workspaceId, roomId, runId }))?.turnStatus).toBe('uncertain');
  } finally {
    client.close();
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    await close();
  }
});
