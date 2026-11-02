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
    if (
      targets.has(mount.target) ||
      !/^\/(?:workspace\/(?:[A-Za-z0-9_-]+\/)*node_modules|toolchain\/pnpm)$/.test(mount.target) ||
      (await realpath(mount.source)) !== mount.source ||
      !(await lstat(mount.source)).isDirectory()
    )
      throw new ToolError('containment_unavailable', 'invalid dependency mount');
    targets.add(mount.target);
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
      } else if (!stat.isFile())
        throw new ToolError('containment_unavailable', 'special dependency file');
    }
    await walk(mount.source);
  }
}
