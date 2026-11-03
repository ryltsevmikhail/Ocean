import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { openOceanProfile } from './profile.js';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';

it.runIf(process.platform === 'linux').each(['sigterm', 'hangup'])(
  'standard room PTY %s detaches from an admitted run; another process reads exactly one answer',
  async (close) => {
    const root = mkdtempSync(join(tmpdir(), 'room-pty-')),
      profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    const offline = openOceanProfile(profile, true);
    await offline.ready;
    const { workspaceId, roomId } = rooms(offline.conversations);
    offline.close();
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
      XDG_RUNTIME_DIR: run,
    };
    const host = spawn(
      process.execPath,
      ['apps/cli/test-fixtures/local-runtime-turn-owner.test.ts', profile, 'success'],
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const exited = new Promise((resolve) => host.once('close', resolve));
    let log = '';
    host.stdout!.on('data', (b: Buffer) => {
      log += b.toString();
    });
    const peer = decisionPeer(profile, run);
    const terminal = async (action: string) =>
      (
        await promisify(execFile)(
          'python3',
          ['apps/cli/test-fixtures/room-tui-pty.py', process.execPath, profile, roomId, action],
          { env },
        )
      ).stdout.trim();
    try {
      await vi.waitFor(() => expect(log).toContain('ready'), { timeout: 5000 });
      const runId = await terminal(close);
      const scope = { workspaceId, roomId };
      expect(await peer('getRun', { ...scope, runId })).toMatchObject({
        runId,
        taskStatus: 'running',
      });
      const runRef = { ...scope, runId };
      const snapshot = await peer('getRun', runRef);
      const receipt = await peer('getReceipt', { ...scope, requestId: snapshot.requestId });
      expect(receipt).toMatchObject({
        runId,
        messageId: snapshot.messageId,
        turnId: snapshot.turnId,
      });
      expect(
        (await peer('listEvents', runRef)).map((event: { type: string }) => event.type),
      ).not.toContain('task_run.cancelling');
      expect(log).not.toContain('abort');
      host.send('success');
      await vi.waitFor(async () =>
        expect(await peer('history', scope)).toMatchObject([
          { id: receipt.messageId, body: 'from the terminal' },
          { body: 'native fixture answer' },
        ]),
      );
      const result = await peer('getResult', runRef);
      expect(await peer('history', { ...scope, after: 1 })).toEqual([result]);
      expect(await peer('getRun', runRef)).toMatchObject({ runId, resultMessageId: result.id });
      expect(await terminal('restore')).toBe(runId);
      expect(await peer('listRuns', scope)).toMatchObject([{ runId, taskStatus: 'succeeded' }]);
      expect(readFileSync(join(profile, 'calls'), 'utf8')).toBe('dispatch\n');
      expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
      console.info(
        'PTY admitted and reattached',
        close,
        JSON.stringify(receipt),
        result.id,
        'one committed answer, provider dispatches 1',
      );
    } finally {
      host.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  25000,
);
