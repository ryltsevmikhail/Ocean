import { acceptanceOwner } from '../../test-fixtures/acceptance-owner.test.js';
import { connect } from 'node:net';
import { once } from 'node:events';
import { readLocalRuntimeDescriptor } from '@runnets/tools-node';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { openOceanProfile } from '../ocean/profile.js';

it.runIf(process.platform === 'linux').each(['cli', 'successor'])(
  'two independent clients recover the same claimed effect through a killed listener restart (%s)',
  async (successor) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-kill-'));
    const profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    const rt = openOceanProfile(profile, true);
    await rt.ready;
    const { roomId, workspaceId, text, requestId } = rooms(rt.conversations);
    const request = { roomId, workspaceId, text, requestId };
    rt.close();
    const scope = { workspaceId: request.workspaceId, roomId: request.roomId };
    const peer = decisionPeer(profile, run);
    const children: (() => Promise<void>)[] = [];
    const launch = (scenario = 'cli') => {
      const host = acceptanceOwner(profile, run, scenario);
      children.push(async () => {
        await host.kill();
      });
      return host;
    };
    const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
    try {
      vi.stubEnv('XDG_RUNTIME_DIR', run);
      let host = launch('claimed');
      await host.ready();
      const original = readLocalRuntimeDescriptor(profile);
      const receipt = await peer('submit', request);
      const ref = { ...scope, runId: receipt.runId };
      const effect = () => db.prepare('SELECT task_run_id,outcome FROM tool_invocations_v2').all();
      await vi.waitFor(() => {
        expect(effect()).toEqual([{ task_run_id: receipt.runId, outcome: 'started' }]);
        expect(readFileSync(join(profile, 'effects'), 'utf8')).toBe('effect\n');
      });
      const originalEffect = db
        .prepare('SELECT id,tool,task_run_id,attempt_id,fingerprint FROM tool_invocations_v2')
        .all();
      const first = await peer('observeRun', ref);
      let cursor: string = first.cursor;
      const instances = new Set([first.instanceId]);
      const restarts = successor === 'cli' ? ['kill', 'kill', 'stop', 'stop'] : ['kill'];
      for (const action of restarts) {
        if (action === 'kill') {
          host.p.kill('SIGKILL');
          expect(await host.exit).toBe('SIGKILL');
        } else {
          expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
          expect(await host.exit).toBe(0);
        }
        host = launch(successor);
        await host.ready();
        const read = async () => {
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
            import {connectLocalRuntime} from '@runnets/tools-node/local-runtime-client';
            const c=await connectLocalRuntime({profile:process.argv[1]});
            const [receipt,observation]=JSON.parse(process.argv[2]);
            try {console.log(JSON.stringify({receipt:await c.getReceipt(receipt),view:await c.observeRun(observation)}));}
            finally {c.close();}
          `,
              profile,
              JSON.stringify([
                { ...scope, requestId },
                { ...ref, cursor },
              ]),
            ],
            {
              env: {
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
                XDG_RUNTIME_DIR: run,
              },
            },
          );
          return JSON.parse(stdout);
        };
        const [a, b] = await Promise.all([read(), read()]);
        expect(b.receipt).toEqual(a.receipt);
        expect(a.receipt).toEqual(receipt);
        expect(a.view).toMatchObject({
          kind: 'resync',
          snapshot: { ...ref, turnStatus: 'uncertain', resultMessageId: null },
        });
        expect(b.view.snapshot).toEqual(a.view.snapshot);
        expect(b.view.instanceId).toBe(a.view.instanceId);
        expect(instances.has(a.view.instanceId)).toBe(false);
        const stale = connect(original.endpoint);
        try {
          const reply = once(stale, 'data');
          stale.write(
            JSON.stringify({
              id: 'stale',
              method: 'hello',
              params: { ...original, instanceId: a.view.instanceId },
            }) + '\n',
          );
          expect(JSON.parse(String((await reply)[0]))).toEqual({
            id: 'stale',
            error: { code: 'authentication_failed' },
          });
        } finally {
          stale.destroy();
        }
        expect(await peer('reviewRoom', scope)).toMatchObject({
          runId: receipt.runId,
          turnStatus: 'uncertain',
          relatedPendingEffects: 1,
          effects: [{ id: 'effect', tool: 'fixture', outcome: 'uncertain' }],
        });
        await expect(peer('submit', { ...request, requestId: 'blocked' })).rejects.toThrow(
          'recovery_required',
        );
        expect(await peer('getReceipt', { ...scope, requestId: 'blocked' })).toBeNull();
        expect(await peer('getResult', ref)).toBeNull();
        expect(await peer('history', scope)).toMatchObject([{ id: receipt.messageId }]);
        const events: { type: string }[] = await peer('listEvents', ref);
        expect(
          events.some((e) => ['task_run.cancelling', 'task_run.cancelled'].includes(e.type)),
        ).toBe(false);
        expect(
          db
            .prepare('SELECT id,tool,task_run_id,attempt_id,fingerprint FROM tool_invocations_v2')
            .all(),
        ).toEqual(originalEffect);
        instances.add(a.view.instanceId);
        cursor = a.view.cursor;
        expect(await peer('submit', request)).toEqual(receipt);
        expect(effect()).toEqual([{ task_run_id: receipt.runId, outcome: 'uncertain' }]);
        if (successor === 'successor')
          expect(readFileSync(join(profile, 'successor.calls'), 'utf8')).toBe('');
        expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
        expect(readFileSync(join(profile, 'effects'), 'utf8')).toBe('effect\n');
      }
      console.info(
        'Effect recovery',
        JSON.stringify(receipt),
        JSON.stringify(originalEffect),
        'instances',
        instances.size,
        successor === 'cli' ? 'ordinary CLI' : 'instrumented successor dispatches 0',
        'original dispatches/effects 1/1, held, no result or confirmed cancellation',
      );
      if (successor === 'successor') {
        expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
        expect(await host.exit).toBe(0);
        expect(readFileSync(join(profile, 'successor.calls'), 'utf8')).toBe('');
        return;
      }
      // Kill again between the successor's no-replace publication link and SQLite proof.
      host.p.kill('SIGKILL');
      expect(await host.exit).toBe('SIGKILL');
      const partial = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
        const link=fs.linkSync;
        fs.linkSync=(src,dst)=>{link(src,dst); if(dst.endsWith('/connection.json')) process.kill(process.pid,'SIGKILL');};
        syncBuiltinESMExports();
        const {startLocalRuntime}=await import('./apps/cli/dist/local-runtime/host.js');
        await startLocalRuntime({profile:process.argv[1],provider:null});
      `,
          profile,
        ],
        {
          env: {
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
            XDG_RUNTIME_DIR: run,
          },
        },
      );
      expect(await new Promise((r) => partial.once('close', (_code, signal) => r(signal)))).toBe(
        'SIGKILL',
      );
      const rejected = launch();
      expect(await rejected.exit).toBe(3);
      expect(effect()).toEqual([{ task_run_id: receipt.runId, outcome: 'uncertain' }]);
      expect(readFileSync(join(profile, 'effects'), 'utf8')).toBe('effect\n');
      expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
    } finally {
      vi.unstubAllEnvs();
      db.close();
      for (const cleanup of children) await cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
