import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { detachedClient } from '../../test-fixtures/detached-client.test.js';

it
  .runIf(process.platform === 'linux')
  .each([
    'success',
    'provider_failure',
    'deadline',
    'draining_retry',
    'observe',
    'cancel',
    'cancel_known',
  ])(
  'independent clients detach and reconnect to one execution through %s',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-job-')),
      profile = join(root, 'profile');
    const runDir = join(root, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    const env = {
      ...Object.fromEntries(
        [
          'HOME',
          'XDG_RUNTIME_DIR',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME',
          'XDG_CACHE_HOME',
          'TMPDIR',
        ].map((key) => [key, process.env[key]]),
      ),
      PATH: process.env['PATH'],
      XDG_RUNTIME_DIR: runDir,
    };
    const runtime = openOceanProfile(profile, true);
    await runtime.ready;
    const { groupId, ...request } = rooms(runtime.conversations);
    runtime.close();
    const host = spawn(
      process.execPath,
      [resolve('apps/cli/test-fixtures/local-runtime-turn-owner.test.ts'), profile, scenario],
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const exited = new Promise((resolve) => host.once('exit', resolve));
    let log = '';
    host.stdout!.on('data', (b: Buffer) => {
      log += b.toString();
    });
    const client = detachedClient({ profile, env, request });
    try {
      await vi.waitFor(() => expect(log).toContain('ready'), { timeout: 5000 });
      const receipt = await client<{ runId: string; turnId: string }>('client.submit(request)');
      expect(receipt.runId).toEqual(expect.any(String));
      expect(await client('client.submit(request)')).toEqual(receipt);
      expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
      const query =
        'client.getRun({workspaceId:request.workspaceId,roomId:request.roomId,runId:' +
        JSON.stringify(receipt.runId) +
        '})';
      if (scenario === 'observe' || scenario.startsWith('cancel')) {
        const scope = { workspaceId: request.workspaceId, roomId: request.roomId };
        const run = { ...scope, runId: receipt.runId };
        const call = <T = unknown>(method: string, params: unknown) =>
          client<T>('client.' + method + '(' + JSON.stringify(params) + ')');
        const observe = <T = unknown>(cursor?: string, waitMs = 0) =>
          call<T>('observeRun', { ...run, cursor, waitMs });
        const initial = await observe<{
          cursor: string;
          snapshot: { version: number; performerId: string };
        }>();
        expect(initial).toMatchObject({
          kind: 'snapshot',
          roomSeq: 1,
          snapshot: { ...run, taskStatus: 'running', pendingDecisionIds: [] },
        });
        const { cursor, snapshot } = initial;
        expect(await observe('unrecognized')).toMatchObject({ kind: 'resync' });
        expect(await observe(cursor, 25)).toMatchObject({ kind: 'timeout', cursor });
        const wrong = { ...run, roomId: groupId };
        for (const method of ['getResult', 'listEvents', 'observeRun']) {
          expect(await call(method, wrong)).toEqual({ error: 'unknown_run' });
          expect(await call(method, { ...run, workspaceId: 'other' })).toEqual({
            error: 'unknown_run',
          });
        }
        expect(await call('getResult', run)).toBeNull();
        if (scenario.startsWith('cancel')) {
          const cancel = { ...run, requestId: 'stop-one', expectedVersion: snapshot.version };
          expect(await call('cancelRun', { ...cancel, expectedVersion: 0 })).toEqual({
            error: 'version_conflict',
          });
          expect(await call('cancelRun', { ...cancel, roomId: groupId })).toEqual({
            error: 'unknown_run',
          });
          expect(log).not.toContain('abort');
          const ack = await call<{ version: number }>('cancelRun', cancel);
          expect(ack).toEqual({ ...cancel, version: snapshot.version + 1, status: 'requested' });
          await vi.waitFor(() => expect(log).toContain('abort'));
          expect(await call('cancelRun', cancel)).toEqual(ack);
          expect(await call('cancelRun', { ...cancel, expectedVersion: ack.version })).toEqual({
            error: 'request_conflict',
          });
          expect(log).toContain('receipt-before-abort');
          expect(await call('cancelRun', { ...cancel, roomId: groupId })).toEqual({
            error: 'request_conflict',
          });
          const known = scenario === 'cancel_known';
          host.send(known ? 'success' : 'release');
          await vi.waitFor(async () =>
            expect(await client(query)).toMatchObject({
              turnStatus: known ? 'cancelled' : 'uncertain',
              taskStatus: known ? 'cancelled' : 'cancelling',
            }),
          );
          expect(await call('cancelRun', cancel)).toEqual(ack);
          const events = await call('listEvents', { ...run, after: ack.version });
          expect(events).toMatchObject(
            known ? [{ type: 'attempt.usage_recorded' }, { type: 'task_run.cancelled' }] : [],
          );
          expect(await client('client.stop()')).toMatchObject({
            outcome: known ? 'complete' : 'uncertain',
          });
        } else {
          expect(
            await call('listRooms', { workspaceId: scope.workspaceId, limit: 1 }),
          ).toHaveLength(1);
          expect(await call('listMembers', scope)).toMatchObject([{ handle: 'dev' }]);
          expect(await call('listRuns', scope)).toMatchObject([
            { runId: run.runId, performerId: snapshot.performerId },
          ]);
          const history = await call('history', scope);
          expect(history).toMatchObject([{ seq: 1, body: 'hello' }]);
          expect(await call('history', { ...scope, after: 100 })).toEqual({
            error: 'resync_required',
          });
          expect(await call('listEvents', { ...run, after: 100 })).toEqual({
            error: 'resync_required',
          });
          expect(await call('listEvents', { ...run, limit: 1 })).toEqual([
            { sequence: 1, type: 'task_run.created', sensitivity: 'internal' },
          ]);
          const watching = observe(cursor, 5000);
          host.send('success');
          expect(await watching).toMatchObject({ kind: 'changed' });
          await vi.waitFor(async () =>
            expect(await client(query)).toMatchObject({ turnStatus: 'completed' }),
          );
          const answer = await call('getResult', run);
          expect(answer).toMatchObject({
            seq: 2,
            body: 'native fixture answer',
            turnId: receipt.turnId,
          });
          expect(await call('history', { ...scope, after: 1 })).toEqual([answer]);
          expect(await call('history', { ...scope, after: 2 })).toEqual([]);
          expect(await client('client.stop()')).toMatchObject({ outcome: 'complete' });
        }
        expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
        return;
      }
      if (scenario === 'draining_retry') {
        const group = { ...request, roomId: groupId, requestId: 'post' };
        const groupReceipt = await client('client.submit(' + JSON.stringify(group) + ')');
        expect(groupReceipt.runId).toBeNull();
        const stop = client('client.stop()');
        try {
          await vi.waitFor(() => expect(log).toContain('abort'));
          for (const phase of ['draining', 'stop_incomplete']) {
            if (phase === 'stop_incomplete') {
              host.send('release');
              expect(await stop).toMatchObject({ state: phase });
            }
            expect((await client('client.status()')).state).toBe(phase);
            expect(await client('client.submit(request)')).toEqual(receipt);
            expect(await client('client.submit({...request,text:"changed"})')).toEqual({
              error: 'request_conflict',
            });
            expect(await client('client.submit(' + JSON.stringify(group) + ')')).toEqual(
              groupReceipt,
            );
            const fresh = { ...group, requestId: 'new' };
            expect(await client('client.submit(' + JSON.stringify(fresh) + ')')).toEqual({
              error: 'runtime_draining',
            });
            expect(
              await client(
                'client.getReceipt(' +
                  JSON.stringify({
                    workspaceId: request.workspaceId,
                    roomId: groupId,
                    requestId: 'new',
                  }) +
                  ')',
              ),
            ).toBeNull();
          }
          expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
        } finally {
          // Release even when an assertion fails while the stop caller waits on this gate.
          if (host.connected) host.send('release');
          await stop;
        }
        return;
      }
      if (scenario !== 'deadline') {
        host.send(scenario);
        const expected =
          scenario === 'success'
            ? {
                turnStatus: 'completed',
                taskStatus: 'succeeded',
                resultMessageId: 'reply_' + receipt.turnId,
              }
            : { turnStatus: 'uncertain', taskStatus: 'failed' };
        await vi.waitFor(async () => expect(await client(query)).toMatchObject(expected), {
          timeout: 5000,
        });
        expect(await client('client.submit(request)')).toEqual(receipt);
        expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
        expect(await client('client.stop()')).toMatchObject({
          outcome: scenario === 'success' ? 'complete' : 'uncertain',
        });
        if (scenario === 'success') {
          const reopened = openOceanProfile(profile);
          try {
            await reopened.ready;
            expect(
              reopened.conversations.history(request.workspaceId, request.roomId),
            ).toMatchObject({
              value: [
                { body: 'hello' },
                { id: 'reply_' + receipt.turnId, body: 'native fixture answer' },
              ],
            });
          } finally {
            reopened.close();
          }
        } else
          expect(() => openOceanProfile(profile)).toThrow(
            expect.objectContaining({ code: 'owner_busy' }),
          );
        return;
      }
      const stop = client('client.stop()');
      await vi.waitFor(() => expect(log).toContain('abort'));
      expect(await client('client.submit({...request,requestId:"after-stop"})')).toEqual({
        error: 'runtime_draining',
      });
      expect(await stop).toMatchObject({ outcome: 'uncertain', state: 'stop_incomplete' });
      expect(() => openOceanProfile(profile)).toThrow(
        expect.objectContaining({ code: 'owner_busy' }),
      );
      host.send('release');
      await vi.waitFor(
        async () =>
          expect(await client(query)).toMatchObject({
            turnStatus: 'uncertain',
            taskStatus: 'cancelling',
          }),
        { timeout: 5000 },
      );
      expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
      expect(() => openOceanProfile(profile)).toThrow(
        expect.objectContaining({ code: 'owner_busy' }),
      );
    } finally {
      host.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
