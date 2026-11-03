import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProjectLeases } from '@runnets/tools-node';
import type { CodingTask, ProjectLease } from '@runnets/domain';
import type { ConversationCommand, ProviderPort } from '@runnets/application';
import { createRuntime } from '../runtime.js';

const sandboxRoot = (task: CodingTask) => Promise.resolve({ root: task.worktreeRoot! });

export const initialMath = 'module.exports=(a,b)=>0;\n';
export const faultyMath = 'module.exports=(a,b)=>a-b;\n';
export const repairedMath = 'module.exports=(a,b)=>a+b;\n';
/** Temporary native acceptance fixture: deterministic providers, actual runtime and sandbox. */
export async function codingWorkflowFixture(kind: 'direct' | 'group') {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-workflow-native-'));
  const project = join(directory, 'project');
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
  const base = git('rev-parse', 'HEAD');
  let deny = true;
  const previews: string[] = [];
  const runtime = createRuntime({
    dbPath: join(directory, 'runtime.sqlite'),
    codingWorktreeDirectory: join(directory, 'worktrees'),
    codingTools: {
      sandbox: sandboxRoot,
      inspectSandbox: sandboxRoot,
      owner: () => ({
        decide: (approval) => {
          previews.push(approval.binding.operation);
          if (deny) {
            deny = false;
            return Promise.resolve('deny' as const);
          }
          return Promise.resolve('allow-once' as const);
        },
      }),
    },
  });
  const held: ProjectLease[] = [];
  const close = () => {
    runtime.close();
    const leases = new SqliteProjectLeases();
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
    const dev = bot('dev'),
      reviewer = bot('review');
    const room =
      kind === 'group'
        ? command({ type: 'CreateGroupRoom', title: 'Team', botIds: [dev, reviewer] })
        : command({ type: 'OpenDirectRoom', botId: dev });
    const reviewRoom =
      kind === 'group' ? room : command({ type: 'OpenDirectRoom', botId: reviewer });
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
        testPresets: [
          {
            id: 'test',
            program: '/toolchain/node',
            args: ['-e', "require('node:assert/strict').equal(require('./math.cjs')(2,3),5)"],
            cwd: '.',
          },
        ],
      },
      { confirm: () => Promise.resolve(true) },
    );
    if (!started.ok) throw Error(started.error.code);
    held.push(started.value.lease);
    const access = {
      workspaceId: 'ws_ocean',
      taskId: 'task',
      roomId: room,
      botId: dev,
      policyVersion: 1,
      capability: 'project_read' as const,
    };
    const prepared = await runtime.codingChanges.prepare(access, {
      confirm: () => Promise.resolve(true),
    });
    if (!prepared.ok) throw Error(prepared.error.code);
    held.push(prepared.value.lease);
    const capture = async (id: string) => {
      const value = await runtime.codingChanges.capture(access, id);
      if (!value.ok) throw Error(value.error.code);
      return value.value;
    };
    const send = (id: string, provider: ProviderPort) =>
      runtime.chat.send({
        workspaceId: 'ws_ocean',
        roomId: room,
        taskId: 'task',
        requestId: id,
        to: 'dev',
        text: 'private-dev-marker: ' + id,
        provider,
        signal: new AbortController().signal,
        emit: () => {},
      });
    return {
      runtime,
      directory,
      project,
      room,
      worktree: prepared.value.root,
      base,
      git,
      previews,
      capture,
      send,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
