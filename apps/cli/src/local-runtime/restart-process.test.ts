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

it.runIf(process.platform === 'linux')(
  'two independent clients recover the same claimed effect through two killed and two clean listener restarts',
  async () => {
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
    const launch = (synthetic = false) => {
      const p = spawn(
        process.execPath,
        synthetic
          ? ['apps/cli/test-fixtures/local-runtime-turn-owner.test.ts', profile, 'claimed']
          : ['apps/cli/dist/main.js', 'runtime', 'start', '--profile', profile, '--json'],
        {
          env: { PATH: process.env['PATH'], XDG_RUNTIME_DIR: run },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      const exit = new Promise((resolve) =>
        p.once('close', (code, signal) => resolve(signal ?? code)),
      );
      children.push(async () => {
        p.kill('SIGKILL');
        await exit;
      });
      let out = '';
      p.stdout!.on('data', (b: Buffer) => {
        out += b.toString();
      });
      const ready = () => vi.waitFor(() => expect(out).toContain('ready'), { timeout: 3000 });
      return { p, exit, ready };
    };
    const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
    try {
      vi.stubEnv('XDG_RUNTIME_DIR', run);
      let host = launch(true);
      await host.ready();
      const original = readLocalRuntimeDescriptor(profile);
      const receipt = await peer('submit', request);
      const ref = { ...scope, runId: receipt.runId };
      const effect = () => db.prepare('SELECT task_run_id,outcome FROM tool_invocations_v2').all();
      await vi.waitFor(() =>
        expect(effect()).toEqual([{ task_run_id: receipt.runId, outcome: 'started' }]),
      );
      const first = await peer('observeRun', ref);
      let cursor: string = first.cursor;
      const instances = new Set([first.instanceId]);
      for (const action of ['kill', 'kill', 'stop', 'stop']) {
        if (action === 'kill') {
          host.p.kill('SIGKILL');
          expect(await host.exit).toBe('SIGKILL');
        } else {
          expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
          expect(await host.exit).toBe(0);
        }
        host = launch();
        await host.ready();
        const read = async () => {
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
            import {connectLocalRuntime} from './packages/tools-node/dist/index.js';
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
            { env: { XDG_RUNTIME_DIR: run } },
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
        instances.add(a.view.instanceId);
        cursor = a.view.cursor;
        expect(await peer('submit', request)).toEqual(receipt);
        expect(effect()).toEqual([{ task_run_id: receipt.runId, outcome: 'uncertain' }]);
        expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
        expect(readFileSync(join(profile, 'effects'), 'utf8')).toBe('effect\n');
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
        { env: { XDG_RUNTIME_DIR: run } },
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
