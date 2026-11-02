import { runCodingApplyCommand } from './coding-apply-command.js';
import { runCodingReviewCommand } from './coding-review-command.js';
import type { ProviderPort } from '@runnets/application';
import { readCodingProjects } from './coding-projects.js';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import type { Runtime } from '../runtime.js';
import { required, type OceanArguments } from './arguments.js';
import { terminalText } from '../tui/text.js';

/** Interactive ownership confirmation is separate from model/tool approval. */
export async function terminalCodingConfirm(preview: unknown): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return false;
  process.stderr.write(terminalText(JSON.stringify(preview, null, 2)) + '\n');
  const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return (await reader.question('Confirm this exact task operation? [y/N] ')) === 'y';
  } finally {
    reader.close();
  }
}
export async function runCodingCommand(
  runtime: Runtime,
  args: OceanArguments,
  requestId: string,
  provider: ProviderPort | null = null,
): Promise<unknown> {
  if (args.positional[0] === 'reconcile-apply') {
    const applicationId = args.positional[1],
      accepted = required(args.flags, 'accept');
    if (
      !applicationId ||
      !runtime.codingApplyResolution ||
      (accepted !== 'before' && accepted !== 'after')
    )
      throw Error('invalid_input');
    const result = await runtime.codingApplyResolution.reconcile(
      { workspaceId: 'ws_ocean', applicationId, accepted, reason: required(args.flags, 'reason') },
      { confirm: terminalCodingConfirm },
    );
    if (!result.ok) throw Error(result.error.code);
    return result.value;
  }
  if (args.positional[0] === 'pending') {
    if (!runtime.toolJournal) throw Error('coding_unavailable');
    const effects = await runtime.toolJournal.pending();
    return {
      applications: effects
        .filter((effect) => effect.tool === 'coding_apply')
        .map((effect) => ({ applicationId: effect.id, outcome: effect.outcome })),
      otherEffects: effects
        .filter((effect) => effect.tool !== 'coding_apply')
        .map((effect) => ({ id: effect.id, tool: effect.tool, outcome: effect.outcome })),
    };
  }
  if (args.positional[0] === 'inspect-apply') {
    const applicationId = args.positional[1];
    if (!applicationId || !runtime.codingApplyInspection)
      throw Error('application inspection unavailable');
    const result = await runtime.codingApplyInspection.inspect({
      workspaceId: 'ws_ocean',
      applicationId,
    });
    if (!result.ok) throw Error(result.error.code);
    return result.value;
  }
  if (args.positional[0] === 'apply') return runCodingApplyCommand(runtime, args, requestId);
  if (['diff', 'review'].includes(args.positional[0] ?? ''))
    return runCodingReviewCommand(runtime, args, requestId, provider);
  const workspaceId = 'ws_ocean';
  if (args.positional[0] === 'show') {
    const id = args.positional[1];
    if (!id) throw Error('task ID required');
    const result = runtime.coding.inspect(workspaceId, id);
    if (!result.ok) throw Error(result.error.code);
    return result.value;
  }
  if (args.positional[0] !== 'start') throw Error('unknown coding command');
  const bots = runtime.conversations.bots(workspaceId);
  if (!bots.ok) throw Error(bots.error.code);
  const resolve = (name: string) => {
    const selected = bots.value.find((bot) => bot.id === name || bot.handle === name);
    if (!selected) throw Error('unknown_bot');
    return selected.id;
  };
  const projectName = required(args.flags, 'project');
  const registered = (await readCodingProjects(args.flags.get('profile'))).find(
    (project) => project.id === projectName,
  );
  if (!registered && !projectName.startsWith('/')) throw Error('unknown project');
  const taskId = args.flags.get('task-id') ?? randomUUID();
  const roomId = required(args.flags, 'room'),
    devBotId = resolve(required(args.flags, 'dev'));
  const result = await runtime.coding.start(
    {
      taskId,
      requestId,
      workspaceId,
      projectRoot: registered?.root ?? projectName,
      ownerRoomId: roomId,
      reviewRoomId: required(args.flags, 'review-room'),
      devBotId,
      reviewBotId: resolve(required(args.flags, 'review')),
      devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
      testPresets: registered?.testPresets ?? [],
    },
    { confirm: terminalCodingConfirm },
  );
  if (!result.ok) throw Error(result.error.code);
  const worktree = await runtime.codingChanges.prepare(
    {
      taskId,
      workspaceId,
      roomId,
      botId: devBotId,
      policyVersion: 1,
      capability: 'project_read',
    },
    { confirm: terminalCodingConfirm },
  );
  if (!worktree.ok) throw Error(worktree.error.code);
  return { task: runtime.coding.inspect(workspaceId, taskId), worktree: worktree.value };
}
