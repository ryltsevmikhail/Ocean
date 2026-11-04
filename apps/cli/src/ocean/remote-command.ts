import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { connectPublishedRuntime, type LocalRuntimeClient } from '@runnets/tools-node';
import { pages } from './remote-room-view.js';
import { page, rooms, remoteRun, workspaceId } from './remote-run-command.js';
import { required, type OceanArguments } from './arguments.js';
import { profileDirectory } from './profile.js';
const transportFailure = new Set([
  'runtime_unreachable',
  'runtime_timeout',
  'connection_closed',
  'invalid_frame',
  'runtime_failure',
]);
export async function routeProfileCommand(
  args: OceanArguments,
  input: Readable,
  output: Writable,
  error: Writable,
): Promise<number | null> {
  const requestId = args.flags.get('request-id') ?? randomUUID();
  const controller = new AbortController();
  let exitCode = 3,
    submitting = false;
  const interrupt = () => {
    exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  // An absent publication returns synchronously. A wire error cannot select the offline path.
  const connection = connectPublishedRuntime(
    profileDirectory(args.flags.get('profile')),
    controller.signal,
  );
  if (!connection) return null;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let c: LocalRuntimeClient | undefined;
  try {
    c = await connection;
    if (args.command === 'send') {
      const roomId = args.positional[0];
      if (!roomId) throw Error('invalid_input');
      const text = required(args.flags, 'text');
      submitting = true;
      const receipt = await c.submit({
        workspaceId,
        roomId,
        requestId,
        text,
        ...(args.flags.has('to') ? { to: required(args.flags, 'to') } : {}),
        ...(args.flags.has('task') ? { taskId: required(args.flags, 'task') } : {}),
      });
      output.write(
        JSON.stringify({
          version: 1,
          ok: true,
          data: { ...receipt, status: receipt.runId === null ? 'recorded' : 'admitted' },
        }) + '\n',
      );
      return 0;
    }
    if (args.command === 'plugin') {
      const { runPluginCommand } = await import('./plugin-command.js');
      const result = await runPluginCommand(c, args, output, input, error);
      output.write(JSON.stringify({ version: 1, ok: true, data: result.data }) + '\n');
      return result.code;
    }
    if (args.command === 'broadcast') {
      const { runBroadcastCommand } = await import('./broadcast-command.js');
      const result = await runBroadcastCommand(c, args, input, output, error, controller.signal);
      output.write(JSON.stringify({ version: 1, ok: true, data: result.data }) + '\n');
      return result.code;
    }
    const { runFinalizationCommand } = await import('./finalization-command.js');
    const result =
      args.command === 'run'
        ? await remoteRun(c, args, requestId, input, error, controller.signal)
        : args.command === 'coding' && args.positional[0] === 'finalize'
          ? { data: await runFinalizationCommand(c, args, input, error), code: 0 }
          : { data: await remoteCommand(c, args, requestId), code: 0 };
    output.write(JSON.stringify({ version: 1, ok: true, data: result.data }) + '\n');
    return result.code;
  } catch (e) {
    if (
      args.command === 'send' &&
      (controller.signal.aborted ||
        (submitting && e instanceof Error && transportFailure.has(e.message)))
    ) {
      const detail = {
        code: 'receipt_unknown',
        message: 'Check the receipt or retry the exact payload and request ID.',
        requestId,
      };
      if (args.json) output.write(JSON.stringify({ version: 1, ok: false, error: detail }) + '\n');
      else error.write(JSON.stringify(detail) + '\n');
      return exitCode;
    }
    if (controller.signal.aborted) return exitCode;
    throw e;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    c?.close();
  }
}
async function remoteCommand(c: LocalRuntimeClient, args: OceanArguments, requestId: string) {
  const { command, flags } = args,
    [sub, id] = args.positional;
  const bots = () =>
    pages(
      (after: string | undefined) => c.listBots({ workspaceId, ...page(after) }),
      (r) => r.id,
    );
  const members = (roomId: string) =>
    pages(
      (after: string | undefined) => c.listMembers({ workspaceId, roomId, ...page(after) }),
      (r) => r.id,
    );
  const base = { workspaceId, requestId };
  if (command === 'bot' && sub === 'add')
    return c.createBot({
      ...base,
      handle: required(flags, 'handle'),
      name: required(flags, 'name'),
      role: required(flags, 'role'),
      provider: flags.get('provider') ?? 'deepseek',
      model: flags.get('model') ?? 'deepseek-flash',
    });
  if (command === 'bot' && sub === 'list')
    return (await bots()).sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  if (command === 'room' && (sub === 'group' || sub === 'direct')) {
    const all = await bots();
    const find = (name: string) => {
      const bot = all.find((b) => b.id === name || b.handle === name);
      if (!bot) throw Error('unknown_bot');
      return bot.id;
    };
    return sub === 'direct'
      ? c.openDirect({ ...base, botId: find(required(flags, 'bot')) })
      : c.createGroup({ ...base, title: required(flags, 'name'), botIds: args.bots.map(find) });
  }
  if (command === 'room' && sub === 'list') {
    const all = [];
    for (const r of await rooms(c))
      all.push(
        r.kind === 'direct'
          ? { workspaceId, id: r.id, kind: r.kind, botId: r.botId }
          : {
              workspaceId,
              id: r.id,
              kind: r.kind,
              title: r.title,
              botIds: (await members(r.id)).map((b) => b.id),
            },
      );
    return all;
  }
  if (command === 'room' && sub === 'members' && id) {
    const bound = await members(id),
      all = new Map((await bots()).map((b) => [b.id, b]));
    return bound.map((m) => {
      const profile = all.get(m.id);
      if (!profile) throw Error('resync_required');
      return profile;
    });
  }
  if (command === 'history' && sub) {
    let after = Number(flags.get('after') ?? 0);
    const limit = Number(flags.get('limit') ?? 50),
      messages = [];
    do {
      const part = await c.history({
        workspaceId,
        roomId: sub,
        after,
        limit: limit - messages.length,
      });
      if (!part.length) break;
      messages.push(...part);
      after = part.at(-1)!.seq;
    } while (messages.length < limit);
    return messages;
  }
  if (command === 'coding') {
    const room = flags.has('room') ? { roomId: required(flags, 'room') } : {};
    if (sub === 'pending') {
      let omittedPendingEffects = 0;
      const applications = await pages(
        async (after: string | undefined) => {
          const result = await c.pendingCoding({ workspaceId, ...room, ...page(after) });
          omittedPendingEffects = result.omittedPendingEffects;
          return result.applications;
        },
        (r) => r.applicationId,
      );
      return {
        scope: 'coding_applications',
        workspaceId,
        ...room,
        applications,
        omittedPendingEffects,
      };
    }
    if (sub === 'show' || sub === 'diff' || sub === 'inspect-apply') {
      if (!id) throw Error('invalid_input');
      return c.codingRead(`coding.${sub}`, { workspaceId, ...room, id });
    }
  }
  if (
    ['backup', 'restore', 'doctor', 'init'].includes(command) ||
    (command === 'project' && sub === 'add') ||
    (command === 'coding' && ['start', 'review', 'apply', 'reconcile-apply'].includes(sub ?? ''))
  )
    throw Error('maintenance_required');
  throw Error('invalid_input');
}
