import { codingProgress } from './coding-progress.js';
import { readFileSync, statSync } from 'node:fs';
import { registeredCodingTools } from './coding-project-host.js';
import { registerCodingProject } from './coding-projects.js';
import { terminalCodingConfirm } from './coding-command.js';
import { runCodingCommand } from './coding-command.js';
import { checkRestoredAccess } from './restored.js';
import { runOperations } from './operations.js';
import { runReviewCommand, terminalReviewApproval } from './review.js';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { ReviewApprovalPort, ProviderPort, ConversationReply } from '@runnets/application';
import { createProviderFromEnv } from '../engine/provider.js';
import { terminalText } from '../tui/approval.js';
import { canonicalWorkspace, openOceanProfile } from './profile.js';
import { oceanArguments, required } from './arguments.js';
import type { Runtime, RuntimeOptions } from '../runtime.js';

export interface OceanCommandOptions {
  readonly codingTools?: RuntimeOptions['codingTools'];
  readonly restoredApproval?: () => Promise<boolean>;
  readonly input?: Readable;
  readonly reviewApproval?: ReviewApprovalPort;
  readonly provider?: ProviderPort | null;
  readonly output?: Writable;
  readonly error?: Writable;
}
/** CLI is a transport for the same persistent conversation services used by the TUI. */
export async function runOceanCommand(
  argv: readonly string[],
  options: OceanCommandOptions = {},
): Promise<number> {
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const json = argv.includes('--json');
  let runtime: Runtime | undefined;
  try {
    const args = oceanArguments(argv);
    const { command, positional, flags } = args;
    if (command === 'runtime') {
      const { runRuntimeCommand } = await import('./runtime-command.js');
      return await runRuntimeCommand(args, output);
    }
    if (args.bots.length > 1 && !(command === 'room' && positional[0] === 'group'))
      throw new Error('Repeated --bot is only valid for group creation');
    if (['doctor', 'backup', 'restore'].includes(command)) {
      const result = await runOperations(args);
      output.write(JSON.stringify({ version: 1, ok: true, data: result.data }) + '\n');
      return result.code;
    }
    await checkRestoredAccess(
      args,
      options.input ?? process.stdin,
      error,
      options.restoredApproval,
    );
    if (command === 'tui') {
      const { runDirectTui } = await import('./tui.js');
      return await runDirectTui({
        profile: flags.get('profile'),
        roomId: required(flags, 'room'),
        ...(flags.has('task') ? { taskId: required(flags, 'task') } : {}),
        provider: options.provider,
      });
    }
    runtime = openOceanProfile(
      flags.get('profile'),
      command === 'init',
      options.codingTools
        ? { codingTools: options.codingTools }
        : command === 'send' && flags.has('task')
          ? { codingTools: registeredCodingTools(flags.get('profile')) }
          : {},
    );
    await runtime.ready;
    const requestId = flags.get('request-id') ?? randomUUID();
    const workspaceId = 'ws_ocean';
    const execute = (
      input: Parameters<Runtime['conversations']['execute']>[0],
    ): ConversationReply => {
      const result = runtime?.conversations.execute(input);
      if (result === undefined) throw new Error('runtime unavailable');
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    };
    let data: unknown;
    if (command === 'project' && positional[0] === 'add') {
      const config = required(flags, 'config');
      if (statSync(config).size > 1048576) throw Error('project configuration too large');
      data = await registerCodingProject(
        flags.get('profile'),
        JSON.parse(readFileSync(config, 'utf8')) as unknown,
        terminalCodingConfirm,
      );
    } else if (command === 'coding') {
      data = await runCodingCommand(
        runtime,
        args,
        requestId,
        args.positional[0] === 'review'
          ? options.provider === undefined
            ? createProviderFromEnv(process.env)
            : options.provider
          : null,
      );
    } else if (command === 'init') {
      data = execute({
        type: 'BindWorkspace',
        requestId: flags.get('request-id') ?? 'ocean-init',
        workspaceId,
        root: canonicalWorkspace(required(flags, 'workspace')),
      });
    } else if (command === 'bot' && positional[0] === 'add') {
      data = execute({
        type: 'CreateBot',
        requestId,
        workspaceId,
        handle: required(flags, 'handle'),
        name: required(flags, 'name'),
        role: required(flags, 'role'),
        provider: flags.get('provider') ?? 'deepseek',
        model: flags.get('model') ?? 'deepseek-flash',
      });
    } else if (command === 'bot' && positional[0] === 'list') {
      const result = runtime.conversations.bots(workspaceId);
      if (!result.ok) throw new Error(result.error.code);
      data = result.value;
    } else if (command === 'room' && positional[0] === 'direct') {
      const handle = required(flags, 'bot');
      const bots = runtime.conversations.bots(workspaceId);
      if (!bots.ok) throw new Error(bots.error.code);
      const bot = bots.value.find((bot) => bot.handle === handle || bot.id === handle);
      if (bot === undefined) throw new Error('unknown_bot');
      data = execute({ type: 'OpenDirectRoom', requestId, workspaceId, botId: bot.id });
    } else if (command === 'room' && positional[0] === 'group') {
      const bots = runtime.conversations.bots(workspaceId);
      if (!bots.ok) throw new Error(bots.error.code);
      const ids = args.bots.map((handle) => {
        const bot = bots.value.find((b) => b.handle === handle || b.id === handle);
        if (bot === undefined) throw new Error('unknown_bot');
        return bot.id;
      });
      data = execute({
        type: 'CreateGroupRoom',
        requestId,
        workspaceId,
        title: required(flags, 'name'),
        botIds: ids,
      });
    } else if (command === 'room' && positional[0] === 'list') {
      const result = runtime.conversations.rooms(workspaceId);
      if (!result.ok) throw new Error(result.error.code);
      data = result.value;
    } else if (command === 'room' && positional[0] === 'members') {
      const roomId = positional[1];
      if (roomId === undefined) throw new Error('room ID required');
      const result = runtime.conversations.members(workspaceId, roomId);
      if (!result.ok) throw new Error(result.error.code);
      data = result.value;
    } else if (command === 'history') {
      const roomId = positional[0];
      if (roomId === undefined) throw new Error('room ID required');
      const result = runtime.conversations.history(
        workspaceId,
        roomId,
        Number(flags.get('after') ?? 0),
        Number(flags.get('limit') ?? 50),
      );
      if (!result.ok) throw new Error(result.error.code);
      data = result.value;
    } else if (command === 'run') {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      try {
        data = await runReviewCommand(
          runtime,
          args,
          requestId,
          options.reviewApproval ?? terminalReviewApproval(options.input ?? process.stdin, error),
          controller.signal,
        );
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    } else if (command === 'send') {
      const roomId = positional[0];
      if (roomId === undefined) throw new Error('room ID required');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      try {
        const result = await runtime.chat.send({
          workspaceId,
          roomId,
          requestId,
          text: required(flags, 'text'),
          to: flags.get('to'),
          ...(flags.has('task') ? { taskId: required(flags, 'task') } : {}),
          provider:
            options.provider === undefined ? createProviderFromEnv(process.env) : options.provider,
          signal: controller.signal,
          emit: (update) => {
            codingProgress(update, error);
            if (!json && update.sessionUpdate === 'agent_message_chunk')
              error.write(terminalText(update.content.text));
          },
        });
        if (!result.ok) throw new Error(result.error.code);
        data = result.value;
        output.write(JSON.stringify({ version: 1, ok: true, data }) + '\n');
        return result.value.status === 'completed' || result.value.status === 'recorded' ? 0 : 4;
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    } else throw new Error('Unknown Ocean command');
    output.write(JSON.stringify({ version: 1, ok: true, data }) + '\n');
    return 0;
  } catch (caught) {
    const message =
      caught instanceof Error && 'code' in caught && caught.code === 'owner_busy'
        ? 'owner_busy'
        : caught instanceof Error
          ? caught.message
          : 'Ocean operation failed';
    // Public errors contain stable classifications, never arbitrary storage paths or payloads.
    const safe = /^[a-z_]+$/.test(message) ? message : 'invalid_input';
    if (json)
      output.write(
        JSON.stringify({ version: 1, ok: false, error: { code: safe, message: safe } }) + '\n',
      );
    else error.write(terminalText(message) + '\n');
    return [
      'owner_busy',
      'room_busy',
      'runtime_absent',
      'runtime_unreachable',
      'endpoint_exists',
    ].includes(safe)
      ? 3
      : [
            'provider_unavailable',
            'recovery_required',
            'context_limit',
            'review_conflict',
            'review_unavailable',
            'approval_required',
            'restore_restricted',
          ].includes(safe)
        ? 4
        : 2;
  } finally {
    runtime?.close();
  }
}
