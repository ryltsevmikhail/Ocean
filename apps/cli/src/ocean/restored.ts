import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { profileDirectory } from './profile.js';
import { readRestorationAuthority } from '@runnets/store-sqlite';
import {
  inspectRuntimeRestoreGuard,
  restoredRuntimeAdmission,
  runtimeIncomplete,
} from '../runtime-restoration.js';
import type { OceanArguments } from './arguments.js';
export function isRestored(profile?: string): boolean {
  const directory = profileDirectory(profile);
  if (runtimeIncomplete(directory)) throw Error('recovery_required');
  const inspection = inspectRuntimeRestoreGuard(directory);
  if (inspection.kind === 'none') return false;
  if (inspection.kind === 'invalid') throw Error('recovery_required');
  const path = join(directory, 'runtime.sqlite');
  if (!existsSync(path)) return true;
  const { origin, active } = readRestorationAuthority(path);
  return restoredRuntimeAdmission(directory, origin, true, active);
}
/** Restore never proves that effects after the snapshot did not happen. */
export async function checkRestoredAccess(
  args: OceanArguments,
  input: Readable,
  output: Writable,
  approve?: () => Promise<boolean>,
): Promise<void> {
  if (!isRestored(args.flags.get('profile'))) return;
  if (args.command === 'tui') return; // TUI can only connect; the maintenance host restricts every dispatch.
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
