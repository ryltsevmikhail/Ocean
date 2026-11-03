import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { LocalFinalizationResult } from '@runnets/contracts';
import { required, type OceanArguments } from './arguments.js';
import { visibleControls } from '../tui/decision-panel.js';
const TERMINAL = ['finalized', 'uncertain', 'refused'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Exact owner finalization over the published runtime; no wire boolean approves it. */
export async function runFinalizationCommand(
  client: LocalRuntimeClient,
  args: OceanArguments,
  input: Readable,
  error: Writable,
): Promise<LocalFinalizationResult | { card: unknown; preview: unknown }> {
  const action = args.positional[1];
  if (!['preview', 'confirm', 'result'].includes(action ?? '')) throw Error('invalid_input');
  const selection = {
    workspaceId: 'ws_ocean',
    roomId: required(args.flags, 'room'),
    taskId: required(args.flags, 'task-id'),
    requestId: required(args.flags, 'request-id'),
  };
  if (action === 'result') return client.finalizationResult(selection);
  const card = await client.previewFinalization(selection);
  const ref = {
    workspaceId: card.workspaceId,
    roomId: card.roomId,
    runId: card.runId,
    decisionId: card.decisionId,
  };
  const preview = await client.decisionPreview(ref);
  if (action === 'preview') return { card, preview: JSON.parse(preview) as unknown };
  if (
    (input as Readable & { isTTY?: boolean }).isTTY !== true ||
    (error as Writable & { isTTY?: boolean }).isTTY !== true
  )
    throw Error('approval_required');
  error.write(
    visibleControls(
      `Finalization decision ${card.decisionId} v${card.version}; SHA-256 ${card.bindingDigest}\n${preview}`,
    ) + '\n',
  );
  const reader = createInterface({ input, output: error });
  let allowed: boolean;
  try {
    allowed =
      (await reader.question(
        'Disable this exact task and release only its exact project lease? [y/N] ',
      )) === 'y';
  } finally {
    reader.close();
  }
  await client.resolveDecision({
    ...ref,
    bindingDigest: card.bindingDigest,
    expectedVersion: card.version,
    choice: allowed ? 'allow-once' : 'deny',
  });
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await client.finalizationResult(selection);
    if (TERMINAL.includes(result.state)) return result;
    await sleep(100);
  }
  throw Error('finalization_pending');
}
