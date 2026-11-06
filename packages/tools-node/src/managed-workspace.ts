import * as fs from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, managedCanonicalRoot, type ManagedWorkspace } from '@runnets/domain';
import { desktopBtrfsAnchor } from './desktop-btrfs-anchor.js';
import { blockedName } from './backend.js';
import {
  managedCoordinate,
  managedMount,
  managedMounts,
  managedTopology,
  mountedPath,
  overlap,
  within,
} from './managed-workspace-mounts.js';
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const fdPath = (fd: number) => '/proc/self/fd/' + fd;
function canonicalDirectory(root: string) {
  if (!managedCanonicalRoot(root) || root === '/' || root.split('/').length > 128)
    throw Error('invalid managed root');
  let fd = fs.openSync('/', flags | fs.constants.O_DIRECTORY);
  try {
    for (const part of root.slice(1).split('/')) {
      const next = fs.openSync(join(fdPath(fd), part), flags | fs.constants.O_DIRECTORY);
      fs.closeSync(fd);
      fd = next;
    }
    if (fs.realpathSync(fdPath(fd)) !== root) throw Error('managed path changed');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export interface ManagedWorkspaceWitness {
  readonly footprint: ManagedWorkspace;
  readonly coordinate: string;
  readonly fd: number;
  inspect(): boolean;
  close(): void;
}
/** Held no-follow directory chain; stable identity deliberately excludes mutable directory timestamps. */
export function openManagedWorkspace(
  root: string,
  signal: AbortSignal,
  forbidden: readonly string[] = [],
  deadline = Date.now() + 15000,
): ManagedWorkspaceWitness {
  signal.throwIfAborted();
  if (Date.now() >= deadline) throw Error('managed inventory deadline');
  const fd = canonicalDirectory(root);
  try {
    const rows = managedMounts(),
      mount = managedMount(fd, rows);
    const coordinate = managedTopology(mount, root, rows);
    for (const path of forbidden) {
      const other = mountedPath(fs.realpathSync(path), rows);
      if (mount.dev === other.mount.dev && overlap(coordinate, other.coordinate))
        throw Error('protected physical managed root');
    }
    const stat = fs.fstatSync(fd, { bigint: true });
    const footprint: ManagedWorkspace = {
      version: 1,
      root,
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      mountNamespace: fs.readlinkSync('/proc/self/ns/mnt'),
      mountId: mount.id,
      dev: String(stat.dev),
      ino: String(stat.ino),
      anchor: desktopBtrfsAnchor(fd),
    };
    let count = 0;
    function walk(directory: number) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw Error('managed inventory deadline');
      const before = fs.fstatSync(directory, { bigint: true });
      const listing = fs.opendirSync(fdPath(directory), { bufferSize: 32 });
      try {
        for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
          signal.throwIfAborted();
          if (Date.now() >= deadline) throw Error('managed inventory deadline');
          if (++count > 50000 || blockedName(entry.name)) throw Error('managed inventory denied');
          const child = fs.openSync(join(fdPath(directory), entry.name), flags);
          try {
            const st = fs.fstatSync(child, { bigint: true });
            if (
              managedMount(child, rows).id !== mount.id ||
              st.dev !== stat.dev ||
              fs.realpathSync(fdPath(child)) !==
                join(fs.realpathSync(fdPath(directory)), entry.name)
            )
              throw Error('managed entry changed');
            if (st.isDirectory()) walk(child);
            else if (!st.isFile() || st.nlink !== 1n) throw Error('unsupported managed file');
          } finally {
            fs.closeSync(child);
          }
        }
      } finally {
        listing.closeSync();
      }
      if (before.ctimeNs !== fs.fstatSync(directory, { bigint: true }).ctimeNs)
        throw Error('managed inventory changed');
    }
    walk(fd);
    let closed = false;
    return {
      footprint,
      coordinate,
      fd,
      inspect() {
        if (closed) return false;
        let current: number | undefined;
        try {
          current = canonicalDirectory(root);
          const next = fs.fstatSync(current, { bigint: true }),
            mounts = managedMounts();
          return (
            String(next.dev) === footprint.dev &&
            String(next.ino) === footprint.ino &&
            managedMount(current, mounts).id === footprint.mountId &&
            managedTopology(managedMount(current, mounts), root, mounts) === coordinate &&
            fs.realpathSync(fdPath(fd)) === root &&
            desktopBtrfsAnchor(current) === footprint.anchor
          );
        } catch {
          return false;
        } finally {
          if (current !== undefined) fs.closeSync(current);
        }
      },
      close() {
        if (!closed) {
          closed = true;
          fs.closeSync(fd);
        }
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function sameManagedWorkspace(a: ManagedWorkspace, b: ManagedWorkspace) {
  return canonicalJson(a) === canonicalJson(b);
}
export { managedCoordinate, managedMount, managedMounts, managedTopology, within };
