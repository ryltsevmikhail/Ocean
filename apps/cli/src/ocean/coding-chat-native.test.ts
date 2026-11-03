import { runCodingReviewCommand } from './coding-review-command.js';
import { oceanArguments } from './arguments.js';
import type { CodingTask, Changeset } from '@runnets/domain';
import { codingTestPassed } from '@runnets/domain';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderPort, ConversationCommand } from '@runnets/application';
import { type RuntimeOptions, createRuntime } from '../runtime.js';

const sandboxRoot = (task: CodingTask) => Promise.resolve({ root: task.worktreeRoot! });

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1').each([
  { kind: 'direct', decision: 'allow-once' as const },
  { kind: 'group', decision: 'allow-once' as const },
  { kind: 'direct', decision: 'deny' as const },
  { kind: 'group', decision: 'deny' as const },
  { kind: 'direct', decision: 'restored' as const },
])(
  'handles $decision dev edits and tests through a $kind conversation',
  async ({ kind, decision }) => {
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
    const options: RuntimeOptions = {
      dbPath: join(root, 'runtime.sqlite'),
      codingWorktreeDirectory: join(root, 'worktrees'),
      codingTools: {
        sandbox: sandboxRoot,
        inspectSandbox: sandboxRoot,
        owner: () => ({
          decide: async (approval) => {
            previews.push(approval.binding.operation);
            return decision === 'restored' ? 'deny' : decision;
          },
        }),
      },
    };
    let runtime = createRuntime(options);

    try {
      await runtime.ready;
      let id = 0;
      const execute = (command: Record<string, unknown>) => {
        const result = runtime.conversations.execute({
          workspaceId: 'ws_ocean',
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
            workspaceId: 'ws_ocean',
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
          workspaceId: 'ws_ocean',
          taskId: 'task',
          roomId: room,
          botId: dev,
          policyVersion: 1,
          capability: 'project_read',
        },
        { confirm: async () => true },
      );
      if (!prepared.ok) throw Error(prepared.error.code);
      if (decision === 'restored') {
        runtime.close();
        await writeFile(join(root, 'restore-guard.json'), '{}');
        runtime = createRuntime({ ...options, restoredAccess: true });
        await runtime.ready;
        let calls = 0;
        const provider: ProviderPort = {
          id: 'fixture',
          models: ['fixture'],
          capabilities: { streaming: true, usage: true, reasoning: false },
          async *stream() {
            calls++;
            yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
          },
        };
        await expect(
          runtime.chat.send({
            workspaceId: 'ws_ocean',
            roomId: room,
            requestId: 'restored',
            taskId: 'task',
            to: 'dev',
            text: 'Try restored tools',
            provider,
            signal: new AbortController().signal,
            emit: () => {},
          }),
        ).rejects.toMatchObject({ code: 'coding_denied' });
        expect(calls).toBe(0);
        expect(previews).toEqual([]);
        expect(await readFile(join(prepared.value.root, 'source.txt'), 'utf8')).toBe('before');
        return;
      }

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
              if (decision === 'allow-once') {
                expect(evidence.content).toContain('"exitCode":0');
                expect(evidence.content).toContain('"sourceUnchanged":true');
              } else expect(evidence.content).toContain('approval_required');
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
        workspaceId: 'ws_ocean',
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
      const evidence = runtime.codingEvidence?.list('task') ?? [];
      expect(evidence).toHaveLength(decision === 'allow-once' ? 1 : 0);
      if (evidence[0]) expect(codingTestPassed(evidence[0])).toBe(true);
      expect(await readFile(join(prepared.value.root, 'source.txt'), 'utf8')).toBe(
        decision === 'allow-once' ? 'after' : 'before',
      );
      expect(await readFile(join(project, 'source.txt'), 'utf8')).toBe('before');
      expect(runtime.toolJournal?.inspectPending?.()).toEqual([]);
      const history = runtime.conversations.history('ws_ocean', room);
      expect(history.ok).toBe(true);
      if (history.ok) {
        expect(history.value.map((message) => message.body)).toEqual([
          'Edit and test',
          'Completed fixture',
        ]);
        expect(JSON.stringify(history.value)).not.toContain('sourceUnchanged');
      }
      const frozen = (await runCodingReviewCommand(
        runtime,
        oceanArguments(['coding', 'diff', 'task']),
        'diff',
        null,
      )) as Changeset;
      expect(frozen.taskId).toBe('task');
      if (decision === 'allow-once') {
        expect(frozen.files).toMatchObject([
          { path: 'source.txt', before: { text: 'before' }, after: { text: 'after' } },
        ]);
      } else expect(frozen.files).toEqual([]);
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
          workspaceId: 'ws_ocean',
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
          workspaceId: 'ws_ocean',
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
