import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { control, retiredGroup } from './sandbox-cgroup.js';
export function managedStdioPrefix(profile: string, connectionId: string) {
  return (
    'ocean-mcp-' +
    createHash('sha256')
      .update(JSON.stringify([profile, connectionId]))
      .digest('hex')
      .slice(0, 32) +
    '-'
  );
}
/** Exact enrollment membership inspection only; never stops or cleans a prefix. */
export async function verifyManagedStdioEnrollments(
  profile: string,
  ids: readonly string[],
  known: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const slice = (
    await control(['show', 'app.slice', '--property=ControlGroup', '--value'], signal)
  ).trim();
  if (
    !/^\/user\.slice\/user-\d+\.slice\/user@\d+\.service\/app\.slice$/.test(slice) ||
    ids.length > 256
  )
    throw Error('managed upgrade unavailable');
  const groups = await readdir('/sys/fs/cgroup' + slice);
  for (const id of ids) {
    signal.throwIfAborted();
    const prefix = managedStdioPrefix(profile, id);
    const listed = await control(
      ['list-units', '--all', '--plain', '--no-legend', '--full', prefix + '*.service'],
      signal,
    );
    const units = new Set(
      [
        ...groups,
        ...listed
          .trim()
          .split('\n')
          .map((s) => s.trim().split(/\s+/)[0] ?? ''),
      ].filter((s) => s.startsWith(prefix)),
    );
    for (const unit of units) {
      if (!/^ocean-mcp-[0-9a-f]{32}-[0-9a-f-]{36}\.service$/.test(unit))
        throw Error('unrecognized managed unit');
      if (!known.includes(unit) && !(await retiredGroup(slice + '/' + unit)))
        throw Error('unjournaled managed writer');
    }
  }
}
