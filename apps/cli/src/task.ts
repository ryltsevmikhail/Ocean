import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import type { ToolPermissionPort } from '@runnets/application';
import { randomUUID } from 'node:crypto';
import { taskRunId } from '@runnets/domain';
import { createRuntimeFromEnv } from './runtime.js';
import { createProviderFromEnv } from './engine/provider.js';
import { createTaskRun } from './acp/session.js';
import { runTurn } from './engine/turn.js';
import { createTools } from './tools.js';
import { terminalText } from './tui/approval.js';

/** Parse the explicitly selected project; the prompt is all remaining positional text. */
export function taskArguments(argv: readonly string[]): { workspace: string; prompt: string } {
  const rest: string[] = [];
  let workspace = process.cwd();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--cwd') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--cwd requires a directory');
      workspace = resolve(value);
    } else if (arg !== undefined) rest.push(arg);
  }
  return { workspace, prompt: rest.join(' ').trim() };
}

/** No terminal means no approval, even if model output asks for one. */
function taskPermissions(): ToolPermissionPort {
  return {
    async review(tool: Parameters<ToolPermissionPort['review']>[0], signal) {
      if (process.stdin.isTTY !== true || signal.aborted) return 'reject';
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      try {
        process.stderr.write(`\n${terminalText(tool.title)}\n${terminalText(tool.preview)}\n`);
        if (tool.kind === 'execute')
          process.stderr.write(
            'This command runs with your user permissions, without OS isolation.\n',
          );
        const choice = await reader.question(
          'Allow? [y] once / [a] same operation for session / [n] deny: ',
          { signal },
        );
        return choice.trim() === 'y'
          ? 'allow_once'
          : choice.trim() === 'a'
            ? 'allow_session'
            : 'reject';
      } catch {
        return 'reject';
      } finally {
        reader.close();
      }
    },
  };
}

/** Run a coding task in the selected workspace and return failure unless the turn completes. */
export async function runTask(argv: readonly string[]): Promise<number> {
  const { workspace, prompt } = taskArguments(argv);
  if (!prompt) {
    process.stderr.write('Usage: runne task [--cwd directory] "task description"\n');
    return 2;
  }
  const provider = createProviderFromEnv(process.env);
  if (provider === null) {
    process.stderr.write('DEEPSEEK_API_KEY is required for coding tasks.\n');
    return 1;
  }
  const runtime = createRuntimeFromEnv();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const recovery = await runtime.ready;
    if (recovery.tasks.length > 0 || recovery.effects.length > 0)
      process.stderr.write('Interrupted work requires review: run runne status.\n');
    const tools = await createTools(workspace, taskPermissions(), runtime.toolJournal);
    const id = taskRunId(`tr_${randomUUID().replaceAll('-', '')}`);
    await createTaskRun({
      service: runtime.service,
      taskRunId: id,
      conversationId: `cv_${id}`,
      workspaceId: `ws_${id}`,
      parentTaskRunId: null,
      model: provider.models[0] ?? 'deepseek-flash',
    });
    const outcome = await runTurn({
      service: runtime.service,
      taskRunId: id,
      provider,
      tools,
      model: provider.models[0] ?? 'deepseek-flash',
      messages: [{ role: 'user', content: prompt }],
      signal: controller.signal,
      emit(update) {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          process.stdout.write(terminalText(update.content.text));
        else if (update.sessionUpdate === 'tool_call')
          process.stderr.write(`\n[tool] ${terminalText(update.title)}\n`);
        else if (update.sessionUpdate === 'tool_call_update') {
          for (const content of update.content ?? [])
            if (content.type === 'content' && content.content.type === 'text')
              process.stderr.write(`${terminalText(content.content.text)}\n`);
        }
      },
    });
    process.stdout.write('\n');
    process.stderr.write(`Task ${id}: ${outcome.kind} (${outcome.stopReason})\n`);
    return outcome.kind === 'completed' ? 0 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    runtime.close();
  }
}
