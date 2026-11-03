import * as fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { connectLocalRuntime } from '@runnets/tools-node';
import { isLocalRestoreInspect, isLocalRestoreSelection } from '@runnets/contracts';
import { required, type OceanArguments } from './arguments.js';
import { profileDirectory } from './profile.js';
import { assertPrivate } from './private-files.js';
import { visibleControls } from '../tui/decision-panel.js';

export async function runRebindCommand(
  args: OceanArguments,
  input: Readable,
  output: Writable,
  error: Writable,
): Promise<number> {
  const action = args.positional[0];
  if (
    args.positional.length !== 1 ||
    !['inspect', 'preview', 'confirm', 'result'].includes(action ?? '') ||
    args.textOnly ||
    [...args.flags.keys()].some((k) => !['profile', 'config'].includes(k))
  )
    throw Error('invalid_input');
  const path = required(args.flags, 'config');
  assertPrivate(path, false);
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let value: unknown;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw Error('invalid_input');
    value = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
  const client = await connectLocalRuntime({
    profile: profileDirectory(args.flags.get('profile')),
  });
  const write = (data: unknown) =>
    output.write(JSON.stringify({ version: 1, ok: true, data }) + '\n');
  try {
    if (action === 'inspect') {
      if (!isLocalRestoreInspect(value)) throw Error('invalid_input');
      write(await client.inspectRestore(value));
      return 0;
    }
    if (!isLocalRestoreSelection(value)) throw Error('invalid_input');
    if (action === 'result') {
      write(await client.restoreResult(value));
      return 0;
    }
    const card = await client.previewRestore(value);
    const ref = {
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    };
    const preview = await client.decisionPreview(ref);
    if (action === 'preview') {
      write({ card, preview: JSON.parse(preview) as unknown });
      return 0;
    }
    if (
      (input as Readable & { isTTY?: boolean }).isTTY !== true ||
      (error as Writable & { isTTY?: boolean }).isTTY !== true
    )
      throw Error('approval_required');
    error.write(
      visibleControls(
        `Restore decision ${card.decisionId} v${card.version}; SHA-256 ${card.bindingDigest}\n${preview}`,
      ) + '\n',
    );
    const reader = createInterface({ input, output: error });
    try {
      const answer = await reader.question(
        'Bind this exact restored tree, policy and new epoch? [y/N] ',
      );
      write(
        await client.resolveDecision({
          ...ref,
          bindingDigest: card.bindingDigest,
          expectedVersion: card.version,
          choice: answer === 'y' ? 'allow-once' : 'deny',
        }),
      );
    } finally {
      reader.close();
    }
    return 0;
  } finally {
    client.close();
  }
}
