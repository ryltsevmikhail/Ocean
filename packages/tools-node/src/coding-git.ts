import { ToolError, type ToolDispatchGuard } from '@runnets/application';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodingArtifactError } from '@runnets/domain';
const execute = promisify(execFile);
/** Only fixed host operations call this helper; checkout/filter execution is never requested. */
export async function codingGit(
  root: string,
  args: readonly string[],
  limit = 33554432,
  guard?: ToolDispatchGuard,
): Promise<Buffer> {
  assertCodingInspection(guard);
  const result = await execute(
    '/usr/bin/git',
    [
      '--no-pager',
      '-c',
      'gc.auto=0',
      '-c',
      'core.excludesFile=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'maintenance.auto=false',
      '-c',
      'core.fsync=all',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'diff.external=',
      '-c',
      'submodule.recurse=false',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: 'buffer',
      timeout: 10000,
      maxBuffer: limit,
      env: {
        PATH: process.env['PATH'],
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    },
  );
  return result.stdout;
}
export function codingPath(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    [...path].some((c) => (c.codePointAt(0) ?? 0) < 32 || c.codePointAt(0) === 127)
  )
    throw new CodingArtifactError('unsupported_file');
}

export function codingText(body: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new CodingArtifactError('unsupported_file');
  }
}

export function assertCodingInspection(guard?: ToolDispatchGuard): void {
  if (guard && guard.inspect?.() !== true)
    throw new ToolError('coding_denied', 'snapshot inspection refused');
}
