import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderPort, ConversationCommand } from '@runnets/application';
import { createRuntime } from '../runtime.js';

it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['direct', 'group'])(
  'runs approved dev edits and tests through a %s conversation',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-chat-native-')),
      project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'source.txt'), 'before');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: project,
        stdio: 'pipe',
      });
    git('init');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    );
    const previews: string[] = [];
    const runtime = createRuntime({
      dbPath: join(root, 'runtime.sqlite'),
      codingWorktreeDirectory: join(root, 'worktrees'),
      codingTools: {
        sandbox: async (task) => ({ root: task.worktreeRoot! }),
        owner: () => ({
          decide: async (approval) => {
            previews.push(approval.binding.operation);
            return 'allow-once';
          },
        }),
      },
    });
    try {
      await runtime.ready;
      let id = 0;
      const execute = (command: Record<string, unknown>) => {
        const result = runtime.conversations.execute({
          workspaceId: 'ws_fixture',
          requestId: String(++id),
          ...command,
        } as ConversationCommand);
        if (!result.ok) throw Error(result.error.code);
        return result.value.data.id;
      };
      execute({ type: 'BindWorkspace', root: project });
      const bot = (handle: string) =>
        execute({
          type: 'CreateBot',
          handle,
          name: handle,
          role: 'Fixture',
          provider: 'fixture',
          model: 'fixture',
        });
      const dev = bot('dev'),
        review = bot('review');
      const room =
        kind === 'group'
          ? execute({ type: 'CreateGroupRoom', title: 'Team', botIds: [dev, review] })
          : execute({ type: 'OpenDirectRoom', botId: dev });
      const reviewRoom =
        kind === 'group' ? room : execute({ type: 'OpenDirectRoom', botId: review });
      expect(
        await runtime.coding.start(
          {
            workspaceId: 'ws_fixture',
            taskId: 'task',
            requestId: 'start',
            projectRoot: project,
            ownerRoomId: room,
            reviewRoomId: reviewRoom,
            devBotId: dev,
            reviewBotId: review,
            devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
            testPresets: [
              {
                id: 'test',
                program: '/toolchain/node',
                args: [
                  '-e',
                  "if(require('node:fs').readFileSync('source.txt','utf8')!=='after')process.exit(1)",
                ],
                cwd: '.',
              },
            ],
          },
          { confirm: async () => true },
        ),
      ).toMatchObject({ ok: true });
      const prepared = await runtime.codingChanges.prepare(
        {
          workspaceId: 'ws_fixture',
          taskId: 'task',
          roomId: room,
          botId: dev,
          policyVersion: 1,
          capability: 'project_read',
        },
        { confirm: async () => true },
      );
      if (!prepared.ok) throw Error(prepared.error.code);
      let round = 0;
      const provider: ProviderPort = {
        id: 'fixture',
        models: ['fixture'],
        capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
        async *stream(request) {
          expect(request.tools?.some((tool) => tool.name === 'run_test')).toBe(true);
          const calls = [
            { id: 'read', name: 'read_file', arguments: '{"path":"source.txt"}' },
            {
              id: 'write',
              name: 'write_file',
              arguments: '{"path":"source.txt","content":"after"}',
            },
            { id: 'test', name: 'run_test', arguments: '{"presetId":"test"}' },
          ];
          const call = calls[round++];
          if (!call) {
            const evidence = request.messages.at(-1);
            expect(evidence?.role).toBe('tool');
            if (evidence?.role === 'tool') {
              expect(evidence.content).toContain('"exitCode":0');
              expect(evidence.content).toContain('"sourceUnchanged":true');
            }
          }
          if (call) yield { type: 'tool_call', call };
          else yield { type: 'text_delta', text: 'Completed fixture' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield {
            type: 'completed',
            stopReason: call ? 'tool_calls' : 'stop',
            rawStopReason: call ? 'tool_calls' : 'stop',
          };
        },
      };
      const result = await runtime.chat.send({
        workspaceId: 'ws_fixture',
        roomId: room,
        requestId: 'send',
        taskId: 'task',
        to: 'dev',
        text: 'Edit and test',
        provider,
        signal: new AbortController().signal,
        emit: () => {},
      });
      expect(result).toMatchObject({ ok: true, value: { status: 'completed' } });
      expect(previews).toEqual(['write', 'test']);
      expect(await readFile(join(prepared.value.root, 'source.txt'), 'utf8')).toBe('after');
      expect(await readFile(join(project, 'source.txt'), 'utf8')).toBe('before');
      expect(runtime.toolJournal?.inspectPending?.()).toEqual([]);
      const history = runtime.conversations.history('ws_fixture', room);
      expect(history.ok).toBe(true);
      if (history.ok) {
        expect(history.value.map((message) => message.body)).toEqual([
          'Edit and test',
          'Completed fixture',
        ]);
        expect(JSON.stringify(history.value)).not.toContain('sourceUnchanged');
      }
      let plainCalls = 0;
      const plain: ProviderPort = {
        ...provider,
        async *stream(request) {
          plainCalls++;
          expect(request.tools).toBeUndefined();
          yield { type: 'text_delta', text: 'Text only' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      };
      expect(
        await runtime.chat.send({
          workspaceId: 'ws_fixture',
          roomId: room,
          requestId: 'plain',
          to: 'dev',
          text: 'Plain chat',
          provider: plain,
          signal: new AbortController().signal,
          emit: () => {},
        }),
      ).toMatchObject({ ok: true, value: { status: 'completed' } });
      expect(plainCalls).toBe(1);
      await expect(
        runtime.chat.send({
          workspaceId: 'ws_fixture',
          roomId: reviewRoom,
          requestId: 'review-tool-refusal',
          taskId: 'task',
          to: 'review',
          text: 'Try tools',
          provider: plain,
          signal: new AbortController().signal,
          emit: () => {},
        }),
      ).rejects.toMatchObject({ code: 'coding_denied' });
      expect(plainCalls).toBe(1);
      expect(previews).toEqual(['write', 'test']);
    } finally {
      runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
