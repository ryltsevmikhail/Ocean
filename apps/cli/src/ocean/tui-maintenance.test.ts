import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime, type LocalRuntimeHost } from '../local-runtime/host.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { runDirectTui } from './tui.js';
import { backupProfile, restoreProfile } from './snapshots.js';

it('admits a TUI only through the maintenance host and refuses its ordinary turn submit', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'tui-maintenance-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  fs.mkdirSync(join(root, 'run'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await codingWorkflowFixture('direct');
  let host: LocalRuntimeHost | undefined;
  try {
    const selected = join(root, 'selected');
    execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'tui maintenance marker\n');
    await f.capture('tui-marker');
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const task = readCodingBackupInventory(join(f.directory, 'runtime.sqlite')).tasks[0]!;
    fs.writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        { id: 'project', root: f.project, testPresets: task.policy.testPresets, mounts: [] },
      ]),
      { mode: 0o600 },
    );
    await backupProfile(f.directory, join(root, 'archive'), {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    fs.rmSync(f.directory, { recursive: true });
    const profile = join(root, 'profile');
    restoreProfile(join(root, 'archive'), profile);
    fs.rmSync(join(root, 'archive'), { recursive: true });
    // A restored TUI with no published maintenance host refuses with its historical code.
    await expect(runDirectTui({ profile, roomId: f.room })).rejects.toThrow('restore_restricted');
    host = await startLocalRuntime({ profile, restore: true, provider: null });
    const client = await connectLocalRuntime({ profile });
    try {
      // The same host allows inspection/preview but refuses an ordinary submitted turn.
      const inspection = await client.inspectRestore({
        workspaceId: 'ws_ocean',
        roomId: f.room,
        taskId: task.id,
        requestId: 'tui-inspect',
        projectRoot: selected,
        policy: task.policy,
      });
      expect(inspection.selection.taskId).toBe(task.id);
      await expect(
        client.submit({
          workspaceId: 'ws_ocean',
          roomId: f.room,
          requestId: 'tui-submit',
          text: 'maintenance must not dispatch',
        }),
      ).rejects.toThrow('restore_restricted');
    } finally {
      client.close();
    }
    let screen = '';
    const input = new PassThrough(),
      output = new PassThrough();
    output.on('data', (b: Buffer) => (screen += b.toString()));
    const session = runDirectTui({ profile, roomId: f.room, input, output });
    try {
      await vi.waitFor(() => expect(screen.length).toBeGreaterThan(0), { timeout: 20000 });
      // The TUI is admitted (it did not throw restore_restricted) and its ordinary submit
      // is refused by the maintenance host rather than reaching a provider.
      input.write('hello from the restored TUI\r');
      await vi.waitFor(() => expect(screen).toContain('restore_restricted'), { timeout: 20000 });
      process.emit('SIGTERM', 'SIGTERM');
      await expect(session).resolves.toBe(0);
    } finally {
      input.end();
    }
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;
  } finally {
    if (host) {
      const stopped = await host.stop();
      if (stopped.outcome === 'complete') await host.closed;
    }
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
