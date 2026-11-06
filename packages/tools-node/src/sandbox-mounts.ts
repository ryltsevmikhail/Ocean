import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, readlink } from 'node:fs/promises';
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
): Promise<string> {
  const hash = createHash('sha256');
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
      hash.update(JSON.stringify([mount.target, await fingerprintFile(mount.source)]));
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
        hash.update(JSON.stringify([relative(mount.source, path), link]));
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
        hash.update(JSON.stringify([relative(mount.source, path), stat.mode]));
        for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
      } else if (!stat.isFile() || stat.nlink !== 1)
        throw new ToolError('containment_unavailable', 'special dependency file');
      else
        hash.update(
          JSON.stringify([
            join(mount.target, relative(mount.source, path)),
            await fingerprintFile(path),
          ]),
        );
    }
    await walk(mount.source);
  }
  return hash.digest('hex');
}

export async function fingerprintFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error('dependency file changed');
    hash.update(JSON.stringify([String(before.mode), String(before.size)]));
    for await (const chunk of file.createReadStream({
      autoClose: false,
      ...(signal ? { signal } : {}),
    }))
      hash.update(chunk as Buffer);
    const after = await file.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('dependency file changed');
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}
