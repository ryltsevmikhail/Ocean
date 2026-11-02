import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';

it.runIf(process.platform === 'linux').each(['success', 'provider_failure', 'deadline'])(
  'independent clients detach and reconnect to one execution through %s',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-job-')),
      profile = join(root, 'profile');
    const runDir = join(root, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    const env = { PATH: process.env['PATH'], XDG_RUNTIME_DIR: runDir };
    const runtime = openOceanProfile(profile, true);
    await runtime.ready;
    const { groupId: _, ...request } = rooms(runtime.conversations);
    runtime.close();
    const host = spawn(
      process.execPath,
      [resolve('apps/cli/test-fixtures/local-runtime-turn-owner.test.ts'), profile],
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const exited = new Promise((resolve) => host.once('exit', resolve));
    let log = '';
    host.stdout!.on('data', (b: Buffer) => {
      log += b.toString();
    });
    const client = async (body: string) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import {connectLocalRuntime} from './packages/tools-node/dist/index.js';
      const client = await connectLocalRuntime({profile:process.argv[1]});
      const request = JSON.parse(process.argv[2]);
      try {console.log(JSON.stringify(await (${body})));} catch(e) {console.log(JSON.stringify({error:e.message}));}
      finally {client.close();}
    `,
          profile,
          JSON.stringify(request),
        ],
        { env },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        err += b.toString();
      });
      const code = await new Promise((resolve) => child.once('close', resolve));
      if (code !== 0) throw Error('client failed: ' + err);
      return JSON.parse(out);
    };
    try {
      await vi.waitFor(() => expect(log).toContain('ready'), { timeout: 5000 });
      const receipt = await client('client.submit(request)');
      expect(receipt.runId).toEqual(expect.any(String));
      expect(await client('client.submit(request)')).toEqual(receipt);
      expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
      const query =
        'client.getRun({workspaceId:request.workspaceId,roomId:request.roomId,runId:' +
        JSON.stringify(receipt.runId) +
        '})';
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
