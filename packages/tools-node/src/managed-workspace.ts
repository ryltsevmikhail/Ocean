import * as fs from 'node:fs';
import * as io from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, managedCanonicalRoot, type ManagedWorkspace } from '@runnets/domain';
import { managedBudget, managedWorkspaceAnchor } from './managed-workspace-anchor.js';
import { blockedName } from './backend.js';
import {
  managedCoordinate,
  managedMount,
  managedMounts,
  managedMountAsync,
  managedMountsAsync,
  managedTopology,
  mountedPath,
  overlap,
  within,
} from './managed-workspace-mounts.js';
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const fdPath = (fd: number) => '/proc/self/fd/' + fd;
async function canonicalDirectory(root: string, signal: AbortSignal, deadline: number) {
  if (!managedCanonicalRoot(root) || root === '/' || root.split('/').length > 128)
    throw Error('invalid managed root');
  managedBudget(signal, deadline);
  let file = await io.open('/', flags | fs.constants.O_DIRECTORY);
  try {
    for (const part of root.slice(1).split('/')) {
      managedBudget(signal, deadline);
      const next = await io.open(join(fdPath(file.fd), part), flags | fs.constants.O_DIRECTORY),
        prior = file;
      file = next;
      await prior.close();
    }
    managedBudget(signal, deadline);
    if ((await io.realpath(fdPath(file.fd))) !== root) throw Error('managed path changed');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
export interface ManagedWorkspaceWitness {
  readonly footprint: ManagedWorkspace;
  readonly coordinate: string;
  readonly fd: number;
  recheck(): Promise<boolean>;
  /** Cheap final held-fd/name continuity only. Expensive topology/anchor checks run in recheck. */
  inspect(): boolean;
  close(): Promise<void>;
}
/** Asynchronous held-fd preparation; every pending I/O retains ownership through actual unwind. */
export async function openManagedWorkspace(
  root: string,
  signal: AbortSignal,
  forbidden: readonly string[] = [],
  deadline = Date.now() + 15000,
): Promise<ManagedWorkspaceWitness> {
  managedBudget(signal, deadline);
  const file = await canonicalDirectory(root, signal, deadline),
    fd = file.fd;
  try {
    managedBudget(signal, deadline);
    const rows = await managedMountsAsync(),
      mount = await managedMountAsync(fd, rows);
    const coordinate = managedTopology(mount, root, rows);
    for (const path of forbidden) {
      managedBudget(signal, deadline);
      const other = mountedPath(await io.realpath(path), rows);
      if (mount.dev === other.mount.dev && overlap(coordinate, other.coordinate))
        throw Error('protected physical managed root');
    }
    const stat = await file.stat({ bigint: true });
    const footprint: ManagedWorkspace = {
      version: 1,
      root,
      boot: (await io.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      mountNamespace: await io.readlink('/proc/self/ns/mnt'),
      mountId: mount.id,
      dev: String(stat.dev),
      ino: String(stat.ino),
      anchor: await managedWorkspaceAnchor(fd, signal, deadline),
    };
    let count = 0;
    async function walk(directory: FileHandle): Promise<void> {
      managedBudget(signal, deadline);
      const before = await directory.stat({ bigint: true }),
        listing = await io.opendir(fdPath(directory.fd), { encoding: 'latin1', bufferSize: 32 });
      try {
        managedBudget(signal, deadline);
        for (let entry = await listing.read(); entry; entry = await listing.read()) {
          managedBudget(signal, deadline);
          const raw = Buffer.from(entry.name, 'latin1'),
            name = raw.toString('utf8');
          if (!raw.equals(Buffer.from(name, 'utf8'))) throw Error('unsupported managed filename');
          if (++count > 50000 || blockedName(name)) throw Error('managed inventory denied');
          const child = await io.open(join(fdPath(directory.fd), name), flags);
          try {
            managedBudget(signal, deadline);
            const st = await child.stat({ bigint: true });
            if (
              (await managedMountAsync(child.fd, rows)).id !== mount.id ||
              st.dev !== stat.dev ||
              (await io.realpath(fdPath(child.fd))) !==
                join(await io.realpath(fdPath(directory.fd)), name)
            )
              throw Error('managed entry changed');
            if (st.isDirectory()) await walk(child);
            else if (!st.isFile() || st.nlink !== 1n) throw Error('unsupported managed file');
          } finally {
            await child.close();
          }
        }
      } finally {
        await listing.close();
      }
      if (before.ctimeNs !== (await directory.stat({ bigint: true })).ctimeNs)
        throw Error('managed inventory changed');
    }
    await walk(file);
    let closed = false,
      fresh = false;
    const witness: ManagedWorkspaceWitness = {
      footprint,
      coordinate,
      fd,
      async recheck() {
        fresh = false;
        if (closed) return false;
        let current: FileHandle | undefined;
        try {
          current = await canonicalDirectory(root, signal, deadline);
          managedBudget(signal, deadline);
          const next = await current.stat({ bigint: true }),
            mounts = await managedMountsAsync(),
            currentMount = await managedMountAsync(current.fd, mounts);
          managedBudget(signal, deadline);
          if (
            String(next.dev) !== footprint.dev ||
            String(next.ino) !== footprint.ino ||
            currentMount.id !== footprint.mountId ||
            managedTopology(currentMount, root, mounts) !== coordinate ||
            (await io.realpath(fdPath(fd))) !== root
          )
            return false;
          fresh = (await managedWorkspaceAnchor(current.fd, signal, deadline)) === footprint.anchor;
          managedBudget(signal, deadline);
          return fresh;
        } catch {
          return false;
        } finally {
          if (current) await current.close();
        }
      },
      inspect() {
        if (closed || !fresh || signal.aborted || Date.now() >= deadline) return false;
        try {
          const held = fs.fstatSync(fd, { bigint: true }),
            named = fs.lstatSync(root, { bigint: true });
          return (
            held.dev === named.dev &&
            held.ino === named.ino &&
            String(held.dev) === footprint.dev &&
            String(held.ino) === footprint.ino &&
            fs.readlinkSync(fdPath(fd)) === root &&
            Date.now() < deadline
          );
        } catch {
          return false;
        }
      },
      async close() {
        if (!closed) {
          closed = true;
          await file.close();
        }
      },
    };
    if (!(await witness.recheck())) throw Error('managed workspace stale');
    return witness;
  } catch (error) {
    await file.close();
    throw error;
  }
}
export function sameManagedWorkspace(a: ManagedWorkspace, b: ManagedWorkspace) {
  return canonicalJson(a) === canonicalJson(b);
}
export { managedCoordinate, managedMount, managedMounts, managedTopology, within };
