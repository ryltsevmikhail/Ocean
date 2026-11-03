import { spawn } from 'node:child_process';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { connectLocalRuntime } from '@runnets/tools-node';

it.each(['race', 'allow', 'deny'] as const)(
  'separate clients read the same review and persist exactly one %s text-only decision',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-owner-race-'));
    const profile = join(root, 'profile');
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
    const offline = openOceanProfile(profile, true);
    await offline.ready;
    const request = rooms(offline.conversations);
    const { workspaceId, roomId } = request;
    const scope = { workspaceId, roomId };
    const turn = await offline.chat.send({
      ...request,
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
    if (!turn.ok || turn.value.status === 'recorded') throw Error('held turn required');
    const runId = turn.value.taskRunId;
    await offline.toolJournal!.claim(
      'foreign-private-invocation',
      'foreign-private-tool',
      { taskRunId: 'tr_foreign', attemptId: 'foreign-private-attempt' },
      'secret',
    );
    offline.close();
    let calls = 0;
    const host = await startLocalRuntime({
      profile,
      provider: {
        id: 'test',
        models: ['test'],
        capabilities: { streaming: true, reasoning: false, usage: true },
        async *stream(q) {
          calls++;
          expect(q.tools).toBeUndefined();
          yield { type: 'text_delta', text: 'fresh text' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      },
    });
    const client = await connectLocalRuntime({ profile });
    const peer = decisionPeer(profile, join(root, 'run'));
    try {
      expect(client.identity.capabilities).toContain('decisions.resolve');
      const review = await client.reviewRoom(scope);
      expect(review).toMatchObject({
        runId,
        globalPendingEffects: 1,
        effects: [],
        canAcknowledge: true,
      });
      expect(JSON.stringify(review)).not.toContain('foreign-private');
      const command = {
        ...scope,
        runId,
        reviewVersion: review.version,
        reason: 'inspected \u009b31m and \u202e evidence',
        requestId: 'continue',
      };
      await expect(
        client.requestContinuation({ ...command, roomId: request.groupId }),
      ).rejects.toThrow();
      await expect(
        client.requestContinuation({ ...command, reviewVersion: '0'.repeat(64) }),
      ).rejects.toThrow('review_conflict');
      const before = await client.observeRoom(scope);
      const pending = await client.requestContinuation(command);
      expect(await client.observeRun({ ...scope, runId })).toMatchObject({
        snapshot: { pendingDecisionIds: [pending.decisionId] },
      });
      expect(await client.observeRoom({ ...scope, cursor: before.cursor })).toMatchObject({
        kind: 'changed',
      });
      const ref = { ...scope, runId, decisionId: pending.decisionId };
      await expect(
        client.requestContinuation({ ...command, requestId: 'competing' }),
      ).rejects.toThrow('decision_pending');
      expect(await client.requestContinuation(command)).toEqual(pending);
      await expect(
        client.requestContinuation({ ...command, reason: 'another reason' }),
      ).rejects.toThrow('request_conflict');
      if (mode === 'deny') {
        const proc = spawn(
          process.execPath,
          [
            'examples/local-runtime-client.mjs',
            profile,
            'decide',
            roomId,
            runId,
            pending.decisionId,
          ],
          { env: { PATH: process.env['PATH'], XDG_RUNTIME_DIR: join(root, 'run') } },
        );
        let output = '',
          err = '';
        proc.stdout.on('data', (b: Buffer) => {
          output += b.toString();
          if (!proc.stdin.writableEnded && output.includes('Enter allow-once or deny'))
            proc.stdin.end('deny\n');
        });
        proc.stderr.on('data', (b: Buffer) => (err += b.toString()));
        expect(await new Promise((resolve) => proc.once('close', resolve)), err).toBe(0);
        expect(output).toContain(pending.bindingDigest);
        expect(JSON.parse(output.split('\n')[1]!)).toBe(await client.decisionPreview(ref));
        expect(output).toContain('denied');
        expect((await client.getDecision(ref)).status).toBe('denied');
      }
      const [one, two] = await Promise.all([
        peer('decisionPreview', ref),
        peer('decisionPreview', ref),
      ]);
      expect(one).toEqual(two);
      expect(JSON.parse(one)).toMatchObject({ snapshot: review, reason: command.reason });
      expect(one).not.toContain('foreign-private');
      expect(one).not.toContain('\u009b');
      expect(one).not.toContain('\u202e');
      const cas = { ...ref, bindingDigest: pending.bindingDigest, expectedVersion: 1 };
      await expect(
        client.resolveDecision({ ...cas, bindingDigest: '0'.repeat(64), choice: 'allow-once' }),
      ).rejects.toThrow();
      const firstChoice = mode === 'deny' ? 'deny' : 'allow-once';
      const secondChoice = mode === 'allow' ? 'allow-once' : 'deny';
      const replies = await Promise.all([
        peer('resolveDecision', { ...cas, choice: firstChoice }),
        peer('resolveDecision', { ...cas, choice: secondChoice }),
      ]);
      expect(replies[0]).toEqual(replies[1]);
      const winner = replies[0];
      expect(['allowed', 'denied']).toContain(winner.status);
      expect(winner.version).toBe(2);
      expect(client.identity.capabilities).toContain('reviews.result');
      expect(await client.continuationApplied(ref)).toBe(winner.status === 'allowed');
      expect(await client.resolveDecision({ ...cas, choice: 'allow-once' })).toEqual(winner);
      expect(await client.getDecision(ref)).toEqual(winner);
      if (winner.status === 'allowed') {
        await expect(
          client.submit({ ...scope, requestId: 'after-review', taskId: 'task', text: 'edit' }),
        ).rejects.toThrow('recovery_required');
        expect(await client.getReceipt({ ...scope, requestId: 'after-review' })).toBeNull();
      }
      expect(await client.history(scope)).toHaveLength(winner.status === 'allowed' ? 2 : 1);
      expect((await client.getRun({ ...scope, runId }))?.turnStatus).toBe('uncertain');
      expect(calls).toBe(0);
      if (winner.status === 'allowed') {
        const receipt = await client.submit({ ...scope, requestId: 'fresh', text: 'continue' });
        await vi.waitFor(async () =>
          expect(await client.getRun({ ...scope, runId: receipt.runId! })).toMatchObject({
            turnStatus: 'completed',
          }),
        );
        expect(calls).toBe(1);
      }
    } finally {
      client.close();
      await host.stop();
      await host.closed;
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
