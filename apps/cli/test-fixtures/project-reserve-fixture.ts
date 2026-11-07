import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { child } from './model-process-rpc.ts';
// eslint-disable-next-line no-restricted-imports -- Test fixture composes the same CLI package's runtime.
import { createRuntime } from '../src/runtime.js';
import type { ConversationCommand } from '@runnets/application';
export async function reserveFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-project-setup-'));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'file'), 'base');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, ...args]);
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
  const runtime = createRuntime({ dbPath: join(directory, 'runtime.sqlite') });
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
  const devBotId = bot('dev'),
    reviewBotId = bot('review');
  const ownerRoomId = command({ type: 'OpenDirectRoom', botId: devBotId });
  const reviewRoomId = command({ type: 'OpenDirectRoom', botId: reviewBotId });
  runtime.close();
  const processes: ReturnType<typeof child>[] = [];
  writeFileSync(
    join(directory, 'coding-projects.json'),
    JSON.stringify([
      {
        id: 'next',
        root: project,
        testPresets: [{ id: 'test', program: '/bin/true', args: [], cwd: '.' }],
        mounts: [],
      },
    ]),
    { mode: 0o600 },
  );
  chmodSync(join(directory, 'runtime.sqlite'), 0o600);
  const run = join(directory, 'r');
  mkdirSync(run, { mode: 0o700 });
  const env = { ...process.env, XDG_RUNTIME_DIR: run };
  const launch = (file: string, mode: string) => {
    const p = child(file, [directory, mode], env);
    processes.push(p);
    return p;
  };
  const input = {
    workspaceId: 'ws_ocean',
    projectId: 'next',
    requestId: 'request',
    taskId: 'next-task',
    ownerRoomId,
    devBotId,
    reviewRoomId,
    reviewBotId,
  };
  return {
    directory,
    project,
    git,
    launch,
    input,
    async close() {
      for (const p of processes.reverse()) await p.kill();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
