import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { RuntimeDecisions } from './decisions.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RuntimeOwnerDecisions, type OwnerDecision } from '@runnets/application';
import { InMemoryOwnerDecisions } from '@runnets/store';
import { connectLocalRuntime } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
import { startLocalRuntime } from './host.js';
const ref = { workspaceId: 'w', roomId: 'r', runId: 'run', decisionId: 'id' };
const card: OwnerDecision = {
  ...ref,
  status: 'pending',
  version: 1,
  kind: 'write',
  createdAt: 5,
  expiresAt: 300005,
  bindingDigest: 'a'.repeat(64),
  previewLength: 5,
};

it.each(['cancel', 'expires', 'backwards', 'race'])(
  'while the exact source is rechecked a %s cannot revive a grant',
  async (mode) => {
    let now = 5;
    const store = new InMemoryOwnerDecisions(),
      owner = new RuntimeOwnerDecisions(store, () => now),
      signal = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting = owner.open(card, 'exact', signal.signal, async () => {
      await gate;
      return true;
    });
    const allow = owner.resolve(ref, card.bindingDigest, 1, 'allow-once');
    if (mode === 'race') await owner.resolve(ref, card.bindingDigest, 1, 'deny');
    if (mode === 'expires') now = 300005;
    if (mode === 'backwards') now = 4;
    if (mode === 'cancel') signal.abort();
    release();
    const result = await allow;
    expect(result.status).toBe(
      mode === 'cancel' ? 'cancelled' : mode === 'race' ? 'denied' : 'expired',
    );
    expect(store.find(ref)?.status).toBe(await waiting);
    expect(await owner.resolve(ref, card.bindingDigest, 1, 'allow-once')).toEqual(result);
  },
);
it('reads a complete multi-frame escaped preview, and refuses the old decisions on a restored profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-decision-large-'));
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const profile = join(root, 'profile'),
    snapshot = join(root, 'backup'),
    restored = join(root, 'restore');
  try {
    const r = openOceanProfile(profile, true);
    await r.ready;
    const text = '\u0000🌊'.repeat(349525);
    const preview = JSON.stringify({ preview: text });
    expect(Buffer.byteLength(preview)).toBeGreaterThan(2 * 1024 * 1024);
    const big = {
      ...card,
      previewLength: preview.length,
      bindingDigest: createHash('sha256').update(preview).digest('hex'),
    };
    r.ownerDecisions.insert(big, preview);
    r.ownerDecisions.settle(big, 'allowed');
    r.ownerDecisions.insert({ ...card, decisionId: 'pending' }, 'exact');
    r.close();
    await backupProfile(profile, snapshot);
    restoreProfile(snapshot, restored);
    await expect(startLocalRuntime({ profile: restored, provider: null })).rejects.toThrow(
      'restore_restricted',
    );
    const host = await startLocalRuntime({ profile, provider: null }),
      client = await connectLocalRuntime({ profile });
    try {
      expect(
        (await client.listDecisions({ workspaceId: 'w', roomId: 'r', limit: 1 }))[0]?.status,
      ).toBe('allowed');
      expect(await client.decisionPreview(ref)).toBe(preview);
      await expect(client.decisionPreview({ ...ref, roomId: 'other' })).rejects.toThrow(
        'unknown_decision',
      );
      expect((await client.getDecision({ ...ref, decisionId: 'pending' })).status).toBe(
        'interrupted',
      );
    } finally {
      client.close();
      await host.stop();
      await host.closed;
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('changing global evidence invalidates a pending room confirmation without disclosing the other run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-review-stale-')),
    r = openOceanProfile(root, true);
  try {
    await r.ready;
    const q = rooms(r.conversations);
    const turn = await r.chat.send({
      ...q,
      provider: {
        id: 'test',
        models: ['test'],
        capabilities: { streaming: true, reasoning: false, usage: true },
        async *stream() {
          yield { type: 'text_delta', text: 'partial' };
        },
      },
      signal: new AbortController().signal,
      emit: () => {},
    });
    if (!turn.ok || turn.value.status === 'recorded') throw Error('expected held turn');
    const owner = new RuntimeDecisions(r.ownerDecisions, r.reviews);
    const { workspaceId, roomId } = q;
    const { view } = await owner.reviews.read({ workspaceId, roomId });
    const card = await owner.reviews.request({
      workspaceId,
      roomId,
      runId: view.runId,
      requestId: 'ack',
      reviewVersion: view.version,
      reason: 'seen',
    });
    await r.toolJournal!.claim(
      'private-foreign-effect',
      'private-tool',
      { taskRunId: 'tr_elsewhere', attemptId: 'private-other' },
      'x',
    );
    const updated = await owner.reviews.read({ workspaceId, roomId });
    expect(updated.view.version).not.toBe(view.version);
    expect(JSON.stringify(updated.view)).not.toContain('private-');
    expect(await owner.owner.resolve(card, card.bindingDigest, 1, 'allow-once')).toMatchObject({
      status: 'invalidated',
    });
    expect(owner.reviews.applied(card)).toBe(false);
    expect(r.conversations.history(workspaceId, roomId)).toMatchObject({
      value: [{ body: q.text }],
    });
    expect(r.toolJournal?.inspectPending?.()).toHaveLength(1);
    await owner.drain();
  } finally {
    r.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('joins one in-flight source check even if cancellation has already woken the operation', async () => {
  const owner = new RuntimeOwnerDecisions(new InMemoryOwnerDecisions(), () => 5),
    abort = new AbortController();
  let checks = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const waiting = owner.open(card, 'exact', abort.signal, async () => {
    checks++;
    await gate;
    return true;
  });
  const a = owner.resolve(ref, card.bindingDigest, 1, 'allow-once'),
    b = owner.resolve(ref, card.bindingDigest, 1, 'allow-once');
  abort.abort();
  expect(await waiting).toBe('cancelled');
  try {
    expect(checks).toBe(1);
    let drained = false;
    const join = owner.joinChecks().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await join;
    expect(drained).toBe(true);
  } finally {
    release();
    await Promise.all([a, b]);
  }
});
