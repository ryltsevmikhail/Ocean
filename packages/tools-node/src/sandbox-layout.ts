import { lstat, realpath, readdir } from 'node:fs/promises';
import { join, relative as pathRelative } from 'node:path';
import { ToolError } from '@runnets/application';
import { validateMounts, type SandboxMount } from './sandbox-mounts.js';
import { blockedName } from './backend.js';

export const SANDBOX_NODE = '/toolchain/node';
export const sandboxLimits = Object.freeze({
  timeoutMs: 60000,
  outputBytes: 32768,
  memoryBytes: 2147483648,
  processes: 256,
});
export interface SandboxRequest {
  readonly root: string;
  readonly expectedInputs?: Readonly<Record<string, string>>;
  readonly mounts?: readonly SandboxMount[];
  readonly dependencyProjectRoot?: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Private input for the fixed filesystem worker. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Fixed file protocol only; command callers retain the default 32 KiB. */
  readonly outputBytes?: number;
}
export interface SandboxEvidence {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitCode: number | null;
  readonly reason: 'exit' | 'timeout' | 'cancelled' | 'unavailable';
  readonly cleanupConfirmed: boolean;
  readonly cgroup: string | null;
}
/** Refuse secret-bearing trees and host hardlink aliases before any worker mount. */
export async function sandboxRoot(
  root: string,
  mounts: readonly SandboxMount[] = [],
  projectRoot?: string,
): Promise<void> {
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
    throw new ToolError('containment_unavailable', 'canonical task root required');
  await validateMounts(mounts, projectRoot);
  const pending = new Set(
    mounts.map((m) => m.target).filter((target) => target.startsWith('/workspace/')),
  );
  pending.add('/workspace/.git');
  let count = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 50000) throw new ToolError('containment_unavailable', 'mount inventory limit');
      if (entry.name === '.git' && directory === root) {
        if (!(await lstat(join(directory, entry.name))).isFile())
          throw new ToolError('containment_unavailable', 'linked worktree required');
        pending.delete('/workspace/.git');
        continue;
      }
      if (
        entry.name === 'node_modules' &&
        pending.delete('/workspace/' + pathRelative(root, join(directory, entry.name)))
      ) {
        if (!entry.isDirectory())
          throw new ToolError(
            'containment_unavailable',
            'dependency destination must be a directory',
          );
        continue;
      }
      if (blockedName(entry.name) || entry.isSymbolicLink())
        throw new ToolError('containment_unavailable', 'protected path in task tree');
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (!stat.isFile() || stat.nlink !== 1)
        throw new ToolError('containment_unavailable', 'unsupported task file');
    }
  }
  await walk(root);
  if (pending.size) throw new ToolError('containment_unavailable', 'missing worker mountpoint');
}
export function sandboxArgv(
  root: string,
  script: string,
  mounts: readonly SandboxMount[] = [],
  nodeBinary: string = process.execPath,
): string[] {
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home',
    '--dir',
    '/home/worker',
    '--bind',
    root,
    '/workspace',
    '--ro-bind',
    '/dev/null',
    '/workspace/.git',
    '--ro-bind',
    nodeBinary,
    SANDBOX_NODE,
    ...mounts.flatMap((m) => ['--ro-bind', m.source, m.target]),
    '--chdir',
    '/workspace',
    '--setenv',
    'HOME',
    '/home/worker',
    '--setenv',
    'PATH',
    '/workspace/node_modules/.bin:/toolchain/pnpm/bin:/toolchain:/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    SANDBOX_NODE,
    '--input-type=commonjs',
    '-e',
    script,
  ];
}
