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
): Promise<unknown> {
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
  const taskId = args.flags.get('task-id') ?? randomUUID();
  const roomId = required(args.flags, 'room'),
    devBotId = resolve(required(args.flags, 'dev'));
  const result = await runtime.coding.start(
    {
      taskId,
      requestId,
      workspaceId,
      projectRoot: required(args.flags, 'project'),
      ownerRoomId: roomId,
      reviewRoomId: required(args.flags, 'review-room'),
      devBotId,
      reviewBotId: resolve(required(args.flags, 'review')),
      devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
      testPresets: [],
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
