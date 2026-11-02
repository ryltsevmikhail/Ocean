import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { profileDirectory } from './profile.js';
import { assertPrivate } from './private-files.js';
import type { OceanArguments } from './arguments.js';
export function isRestored(profile?: string): boolean {
  const marker = join(profileDirectory(profile), 'restore-guard.json');
  if (!existsSync(marker)) return false;
  assertPrivate(marker, false);
  try {
    const markerData = JSON.parse(readFileSync(marker, 'utf8')) as { state?: unknown };
    if (markerData.state !== 'ready') throw new Error();
  } catch {
    throw new Error('recovery_required');
  }
  return true;
}
/** Restore never proves that effects after the snapshot did not happen. */
export async function checkRestoredAccess(
  args: OceanArguments,
  input: Readable,
  output: Writable,
  approve?: () => Promise<boolean>,
): Promise<void> {
  if (!isRestored(args.flags.get('profile'))) return;
  const read =
    args.command === 'history' ||
    (['bot', 'room'].includes(args.command) &&
      ['list', 'members'].includes(args.positional[0] ?? '')) ||
    (args.command === 'run' &&
      ['list', 'show', 'review', 'acknowledge'].includes(args.positional[0] ?? ''));
  if (read) return;
  if (args.command !== 'send' || !args.textOnly) throw new Error('restore_restricted');
  if (approve) {
    if (!(await approve())) throw new Error('approval_required');
    return;
  }
  if ((input as Readable & { isTTY?: boolean }).isTTY !== true)
    throw new Error('approval_required');
  output.write(
    'Restored snapshot may omit later actions or charges. Only a new text-only request is allowed; old work is never retried.\n',
  );
  const reader = createInterface({ input, output });
  try {
    if ((await reader.question('Send this text-only request? [y/N] ')).trim() !== 'y')
      throw new Error('approval_required');
  } finally {
    reader.close();
  }
}
