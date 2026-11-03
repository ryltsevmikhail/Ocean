import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { codingTestPassed } from '@runnets/domain';
import type { CodingAccess, ProjectLease } from '@runnets/domain';
import type { ConversationCommand, RuntimeRecovery } from '@runnets/application';
import { SqliteProjectLeases } from '@runnets/tools-node';
import { initialMath } from './coding-workflow-fixture.js';
import { finishWorker, observedUnit, systemdEnv } from './coding-test-spawn-crash-cleanup.js';
import { createRuntime, type Runtime } from '../runtime.js';

const token = 'oceanSpawn' + randomUUID().replaceAll('-', '');
const slowPreset = {
  id: 'slow',
  program: '/toolchain/node',
  args: ['-e', `const ${token}=0;setTimeout(()=>{},6000);`],
  cwd: '.' as const,
};
const running = (): boolean => {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync('/proc/' + entry + '/cmdline', 'utf8').includes(token)) return true;
    } catch {
      /* process exited while scanning */
    }
  }
  return false;
};
async function reopen<T>(
  path: string,
  work: (runtime: Runtime, recovery: RuntimeRecovery) => Promise<T>,
): Promise<T> {
  const runtime = createRuntime({ dbPath: path });
  try {
    const recovery = await runtime.ready;
    return await work(runtime, recovery);
  } finally {
    runtime.close();
  }
}
async function slowFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-spawn-crash-'));
  const project = join(directory, 'project');
  const database = join(directory, 'runtime.sqlite');
  mkdirSync(project);
  writeFileSync(join(project, 'math.cjs'), initialMath);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  const sandbox = async (task: { worktreeRoot: string | null }) => ({ root: task.worktreeRoot! });
  const runtime = createRuntime({
    dbPath: database,
    codingWorktreeDirectory: join(directory, 'worktrees'),
    codingTools: {
      sandbox,
      inspectSandbox: sandbox,
      owner: () => ({ decide: async () => 'allow-once' }),
    },
  });
  const leases = new SqliteProjectLeases();
  const held: ProjectLease[] = [];
  const close = () => {
    runtime.close();
    for (const lease of held) leases.release(lease);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await runtime.ready;
    let sequence = 0;
    const command = (value: Record<string, unknown>) => {
      const result = runtime.conversations.execute({
        workspaceId: 'ws_ocean',
        requestId: String(++sequence),
        ...value,
      } as ConversationCommand);
      if (!result.ok) throw Error(result.error.code);
      return result.value.data.id;
    };
    command({ type: 'BindWorkspace', root: project });
    const bot = (handle: string) =>
      command({
        type: 'CreateBot',
        handle,
        name: handle,
        role: 'Fixture',
        provider: 'fixture',
        model: 'fixture',
      });
    const dev = bot('dev');
    const reviewer = bot('review');
    const room = command({ type: 'OpenDirectRoom', botId: dev });
    const reviewRoom = command({ type: 'OpenDirectRoom', botId: reviewer });
    const started = await runtime.coding.start(
      {
        workspaceId: 'ws_ocean',
        taskId: 'task',
        requestId: 'start',
        projectRoot: project,
        ownerRoomId: room,
        devBotId: dev,
        reviewRoomId: reviewRoom,
        reviewBotId: reviewer,
        devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
        testPresets: [slowPreset],
      },
      { confirm: () => Promise.resolve(true) },
    );
    if (!started.ok) throw Error(started.error.code);
    held.push(started.value.lease);
    const access: CodingAccess = {
      workspaceId: 'ws_ocean',
      taskId: 'task',
      roomId: room,
      botId: started.value.devBotId,
      policyVersion: 1,
      capability: 'project_read',
    };
    const prepared = await runtime.codingChanges.prepare(access, {
      confirm: () => Promise.resolve(true),
    });
    if (!prepared.ok) throw Error(prepared.error.code);
    held.push(prepared.value.lease);
    return { directory, database, room, worktree: prepared.value.root, runtime, close };
  } catch (error) {
    close();
    throw error;
  }
}
async function spawnWorker(directory: string, room: string, phase: string) {
  const child = spawn(
    process.execPath,
    [
      'apps/cli/test-fixtures/coding-test-spawn-crash-worker.test.ts',
      directory,
      room,
      'slow',
      phase,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...(Object.fromEntries(
          [
            'HOME',
            'XDG_RUNTIME_DIR',
            'XDG_CONFIG_HOME',
            'XDG_DATA_HOME',
            'XDG_STATE_HOME',
            'XDG_CACHE_HOME',
            'TMPDIR',
          ].map((key) => [key, process.env[key]]),
        ) as Record<string, string>),
        PATH: process.env['PATH']!,
      },
    },
  );
  let out = '';
  child.stdout.on('data', (buffer: Buffer) => {
    out += buffer.toString();
  });
  child.stderr.on('data', (buffer: Buffer) => {
    out += buffer.toString();
  });
  const exit = new Promise<[number | null, string | null]>((resolve) =>
    child.once('close', (code, signal) => resolve([code, signal])),
  );
  await vi.waitFor(() => expect(out, 'worker not ready').toContain('ready\n'), {
    timeout: 20000,
  });
  return { child, out: () => out, exit };
}
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'keeps a killed runtime test claim uncertain and never passed',
  async () => {
    const f = await slowFixture();
    f.runtime.close();
    chmodSync(f.database, 0o600);
    try {
      const runtimeDeath = await spawnWorker(f.directory, f.room, 'runtime');
      try {
        await vi.waitFor(() => expect(running()).toBe(true), { timeout: 30000 });
        runtimeDeath.child.kill('SIGKILL');
        expect(await runtimeDeath.exit).toEqual([null, 'SIGKILL']);
        await vi.waitFor(() => expect(running()).toBe(false), { timeout: 30000 });
        for (let index = 0; index < 2; index++)
          await reopen(f.database, async (runtime, recovery) => {
            expect(recovery.effects).toMatchObject([{ tool: 'coding_test', outcome: 'uncertain' }]);
            expect(await runtime.toolJournal!.pending()).toMatchObject([
              { tool: 'coding_test', outcome: 'uncertain' },
            ]);
            expect(runtime.codingEvidence!.list('task')).toEqual([]);
            expect(runtime.codingEvidence!.latestForPreset('task', 'slow', 65536)).toBeNull();
            expect(
              await runtime.toolJournal!.claim(
                'fresh',
                'coding_test',
                { taskRunId: 'unrelated', attemptId: 'unrelated' },
                'fingerprint',
              ),
            ).toBe(false);
            expect(readdirSync(f.worktree).sort()).toEqual(['.git', 'math.cjs']);
            expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(initialMath);
          });
      } finally {
        await finishWorker(runtimeDeath, observedUnit(runtimeDeath.out()));
      }
    } finally {
      f.close();
    }
  },
  120000,
);
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'records but never passes a preset whose supervised cgroup was stopped',
  async () => {
    const f = await slowFixture();
    f.runtime.close();
    chmodSync(f.database, 0o600);
    try {
      const cgroup = await spawnWorker(f.directory, f.room, 'cgroup');
      let unit: string | undefined;
      try {
        await vi.waitFor(() => expect(running()).toBe(true), { timeout: 30000 });
        unit = observedUnit(cgroup.out());
        expect(unit).toMatch(/^ocean-worker-[0-9a-f-]+\.service$/);
        execFileSync('/usr/bin/systemctl', ['--user', 'stop', unit!], {
          env: systemdEnv,
          timeout: 10000,
        });
        await vi.waitFor(() => expect(cgroup.out()).toContain('done\n'), { timeout: 30000 });
        expect(await cgroup.exit).toEqual([0, null]);
        for (let index = 0; index < 2; index++)
          await reopen(f.database, async (runtime) => {
            const retained = runtime.codingEvidence!.list('task');
            expect(retained).toHaveLength(1);
            const test = retained[0]!;
            expect(codingTestPassed(test)).toBe(false);
            expect(test.beforeTreeHash).toBe(test.afterTreeHash);
            // systemd reports the stop as a clean service exit; the supervisor's
            // reserved SIGTERM status (75) is the child-invisible proof it was stopped.
            expect(test.reason).toBe('exit');
            expect(test.exitCode).toBe(75);
            expect(test.cleanupConfirmed).toBe(true);
            expect(await runtime.toolJournal!.pending()).toHaveLength(0);
            const database = new DatabaseSync(f.database, { readOnly: true });
            try {
              expect(
                database
                  .prepare('SELECT outcome FROM tool_invocations_v2 WHERE tool=?')
                  .get('coding_test'),
              ).toMatchObject({ outcome: 'failed' });
            } finally {
              database.close();
            }
            expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(initialMath);
          });
      } finally {
        await finishWorker(cgroup, unit ?? observedUnit(cgroup.out()));
      }
    } finally {
      f.close();
    }
  },
  120000,
);
