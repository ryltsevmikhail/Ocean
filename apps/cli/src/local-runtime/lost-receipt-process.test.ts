import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { acceptanceOwner } from '../../test-fixtures/acceptance-owner.test.js';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { openOceanProfile } from '../ocean/profile.js';

it.runIf(process.platform === 'linux').each(['lost', 'gap'])(
  'recovers a dropped post-commit receipt through separate clients and SIGKILL (%s)',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-ack-'));
    const profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    const offline = openOceanProfile(profile, true);
    await offline.ready;
    const { groupId, ...request } = rooms(offline.conversations);
    offline.close();
    const scope = { workspaceId: request.workspaceId, roomId: request.roomId };
    const key = { ...scope, requestId: request.requestId };
    const peer = decisionPeer(profile, run);
    const drop = join(profile, 'ack.drop');
    const calls = () => readFileSync(join(profile, 'calls'), 'utf8');
    const gap = scenario === 'gap';
    let owner = acceptanceOwner(profile, run, scenario);
    try {
      await owner.ready();
      writeFileSync(drop, '');
      await expect(peer('submit', request)).rejects.toThrow('connection_closed');
      expect(existsSync(drop)).toBe(false);
      const receipt = await peer('getReceipt', key);
      expect(receipt).toMatchObject({
        ...key,
        messageId: expect.any(String),
        runId: expect.any(String),
      });
      const ref = { ...scope, runId: receipt.runId };
      const retry = async () => {
        expect(await peer('submit', request)).toEqual(receipt);
        for (const changed of [
          { text: 'other' },
          { to: 'ops' },
          { roomId: groupId },
          { taskId: 'other' },
        ]) {
          await expect(peer('submit', { ...request, ...changed })).rejects.toThrow(
            'request_conflict',
          );
        }
      };
      await retry();
      const before = await peer('getRun', ref);
      expect(before).toMatchObject(
        gap
          ? { taskStatus: 'admitted_before_run', turnStatus: 'accepted', version: 0 }
          : { taskStatus: 'running', turnStatus: 'dispatching' },
      );
      if (!gap) {
        owner.p.send('success');
        await vi.waitFor(async () =>
          expect(await peer('getRun', ref)).toMatchObject({ turnStatus: 'completed' }),
        );
      }
      expect(await owner.kill()).toBe('SIGKILL');
      owner = acceptanceOwner(profile, run, 'successor');
      await owner.ready();
      await retry();
      const after = await peer('getRun', ref);
      expect(after).toMatchObject(
        gap
          ? { ...receipt, taskStatus: 'not_created', turnStatus: 'failed', version: 0 }
          : { ...receipt, taskStatus: 'succeeded', turnStatus: 'completed' },
      );
      const result = await peer('getResult', ref);
      if (gap) expect(result).toBeNull();
      else
        expect(result).toMatchObject({
          id: 'reply_' + receipt.turnId,
          body: 'native fixture answer',
        });
      expect(await peer('history', scope)).toMatchObject([
        { id: receipt.messageId, body: request.text },
        ...(result ? [result] : []),
      ]);
      expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
      expect(await owner.exit).toBe(0);
      expect(calls()).toBe(gap ? '' : 'dispatch\n');
      expect(readFileSync(join(profile, 'successor.calls'), 'utf8')).toBe('');
      console.info(
        'Lost receipt',
        scenario,
        JSON.stringify(receipt),
        before.taskStatus,
        after.taskStatus,
        'result',
        result?.id ?? null,
        'original/successor dispatches',
        gap ? '0/0' : '1/0',
      );
    } finally {
      await owner.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

it.runIf(process.platform === 'linux')(
  'detects an actual dispatch through the successor tripwire with the same persisted bot/model',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-tripwire-'));
    const profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    const offline = openOceanProfile(profile, true);
    await offline.ready;
    const { groupId: _, ...request } = rooms(offline.conversations);
    offline.close();
    const owner = acceptanceOwner(profile, run, 'successor');
    const peer = decisionPeer(profile, run);
    try {
      await owner.ready();
      const receipt = await peer('submit', request);
      const ref = {
        workspaceId: request.workspaceId,
        roomId: request.roomId,
        runId: receipt.runId,
      };
      await vi.waitFor(async () =>
        expect(await peer('getRun', ref)).toMatchObject({
          turnStatus: 'uncertain',
          taskStatus: 'reconciling',
        }),
      );
      expect(await peer('getResult', ref)).toBeNull();
      const events = (await peer('listEvents', { ...ref, after: 0, limit: 50 })) as {
        type: string;
      }[];
      expect(events.map((e) => e.type)).toContain('attempt.model_request_settled');
      expect(events.map((e) => e.type)).toContain('task_run.reconciling');
      expect(events.map((e) => e.type)).not.toContain('task_run.failed');
      expect(readFileSync(join(profile, 'successor.calls'), 'utf8')).toBe('dispatch\n');
      console.info('Isolated positive control', receipt.runId, 'successor tripwire trips 1');
    } finally {
      await owner.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
