import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { openOceanProfile } from './profile.js';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { gatedProvider, rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from '../local-runtime/host.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { gate } from '../../test-fixtures/remote-terminal.test.js';

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

it('routes the built --projects entry and rejects ambiguous room flags', async () => {
  const run = async (...args: string[]) => {
    try {
      return await promisify(execFile)(process.execPath, ['apps/cli/dist/main.js', 'tui', ...args]);
    } catch (e) {
      return e;
    }
  };
  expect(await run('--projects', '--room', 'r')).toMatchObject({
    code: 2,
    stderr: expect.stringContaining('--projects cannot be used with --room or --task'),
  });
  const dir = mkdtempSync(join(tmpdir(), 'project-tui-entry-'));
  try {
    expect(await run('--projects', '--profile', dir)).toMatchObject({
      code: 3,
      stderr: expect.stringContaining('runtime_absent'),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')(
  'a project chooser hands off the built PTY and reattaches after hangup',
  async () => {
    const f = await codingWorkflowFixture('group');
    const release = gate();
    try {
      const task = f.runtime.coding.inspect('ws_ocean', 'task');
      if (!task.ok) throw Error('fixture task');
      f.runtime.close();
      chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      writeFileSync(
        join(f.directory, 'coding-projects.json'),
        JSON.stringify([
          {
            id: 'fixture',
            root: f.project,
            testPresets: task.value.policy.testPresets,
            mounts: [],
          },
        ]),
        { mode: 0o600 },
      );
      const run = join(f.directory, 'run');
      mkdirSync(run, { mode: 0o700 });
      vi.stubEnv('XDG_RUNTIME_DIR', run);
      const signals: AbortSignal[] = [];
      const provider = {
        ...gatedProvider(
          () => release.wait,
          (signal) => signals.push(signal),
        ),
        id: 'fixture',
        models: ['fixture'],
      };
      const host = await startLocalRuntime({ profile: f.directory, provider });
      const peer = await connectLocalRuntime({ profile: f.directory });
      try {
        const terminal = async (action: string) =>
          (
            await promisify(execFile)('python3', [
              'apps/cli/test-fixtures/room-tui-pty.py',
              process.execPath,
              f.directory,
              f.room,
              action,
              'projects',
            ])
          ).stdout.trim();
        const scope = { workspaceId: 'ws_ocean', roomId: f.room };
        const runId = await terminal('hangup');
        const run = await vi.waitFor(async () => {
          const current = await peer.getRun({ ...scope, runId });
          expect(current).toMatchObject({
            performerId: task.value.devBotId,
            turnStatus: 'dispatching',
          });
          expect(signals).toHaveLength(1);
          return current;
        });
        expect(
          await peer.getReceipt({ ...scope, requestId: run!.requestId, taskId: 'task' }),
        ).toMatchObject({ runId });
        expect(signals[0]?.aborted).toBe(false);
        release.open();
        expect(await terminal('restore')).toBe(runId);
        expect(await peer.listRuns(scope)).toMatchObject([{ runId, turnStatus: 'completed' }]);
        expect(signals).toHaveLength(1);
      } finally {
        release.open();
        peer.close();
        await host.stop();
        await host.closed;
      }
    } finally {
      vi.unstubAllEnvs();
      f.close();
    }
  },
  20000,
);
