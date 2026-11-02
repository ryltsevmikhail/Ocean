import { lstat, realpath, readdir, readlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { ToolError } from '@runnets/application';
export interface SandboxMount {
  readonly source: string;
  readonly target: string;
}
/** The owner supplies exact dependency/toolchain roots, never a home/root mount. */
export async function validateMounts(
  mounts: readonly SandboxMount[],
  projectRoot?: string,
): Promise<void> {
  const mapped = [
    ...mounts,
    ...(projectRoot ? [{ source: projectRoot, target: '/workspace' }] : []),
  ];
  const targets = new Set<string>();
  let count = 0;
  for (const mount of mounts) {
    if (targets.has(mount.target) || (await realpath(mount.source)) !== mount.source)
      throw new ToolError('containment_unavailable', 'invalid dependency mount');
    targets.add(mount.target);
    const stat = await lstat(mount.source);
    if (mount.target === '/toolchain/pnpm/bin/pnpm') {
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) === 0)
        throw new ToolError('containment_unavailable', 'expected standalone pnpm executable');
      continue;
    }
    if (
      !projectRoot ||
      !/^\/workspace\/(?:[A-Za-z0-9_-]+\/)*node_modules$/.test(mount.target) ||
      mount.source !== join(projectRoot, relative('/workspace', mount.target)) ||
      !stat.isDirectory()
    )
      throw new ToolError('containment_unavailable', 'invalid dependency root');
    async function walk(path: string): Promise<void> {
      if (++count > 100000)
        throw new ToolError('containment_unavailable', 'dependency inventory limit');
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const link = await readlink(path);
        const actual = await realpath(path);
        const owner = mapped.find((m) => actual === m.source || actual.startsWith(m.source + '/'));
        const current = resolve(mount.target, relative(mount.source, path), '..', link);
        if (
          link.startsWith('/') ||
          !owner ||
          current !== resolve(owner.target, relative(owner.source, actual))
        )
          throw new ToolError(
            'containment_unavailable',
            'dependency symlink escapes explicit mount closure',
          );
      } else if (stat.isDirectory()) {
        for (const entry of await readdir(path)) await walk(join(path, entry));
      } else if (!stat.isFile() || stat.nlink !== 1)
        throw new ToolError('containment_unavailable', 'special dependency file');
    }
    await walk(mount.source);
  }
}
