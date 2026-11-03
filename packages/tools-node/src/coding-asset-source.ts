import { checkProfileArchiveFile } from './profile-archive-context.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { type AssetSelection } from './coding-asset-selection.js';
import { join } from 'node:path';
import type { CodingAssetEntry } from '@runnets/domain';
import { checkAssetPolicy, type CodingAssetPolicy } from './coding-asset-policy.js';
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const fdPath = (fd: number) => '/proc/self/fd/' + String(fd);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
import {
  hashAssetBytes,
  codingAssetIdentity,
  codingAssetMount,
  type CodingAssetLimits,
  type PublicationGuards,
  type CodingAssetCapture,
} from './coding-asset-state.js';
function same(before: fs.BigIntStats, after: fs.BigIntStats): void {
  if (codingAssetIdentity(before) !== codingAssetIdentity(after)) throw Error('stale_coding_asset');
}
function text(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw Error('unsupported_coding_asset');
  }
}
export function scanAssetSource(
  root: string,
  limits: CodingAssetLimits,
  policy: CodingAssetPolicy,
  expected?: { entries: ReadonlyMap<string, string>; mount: string },
  metadataOnly = false,
  pinned?: number,
  selection?: AssetSelection,
  publications?: { candidates?: Set<string>; guards?: PublicationGuards },
  account?: (values: {
    stored: number;
    logical: number;
    metadata: number;
    entries: number;
  }) => void,
): CodingAssetCapture {
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || uid === undefined || fs.realpathSync(root) !== root)
    throw Error('unsupported_coding_asset');
  const rootStat = fs.lstatSync(root, { bigint: true });
  const rootFd = pinned ?? fs.openSync(root, directoryFlags);
  let rootMount = '';
  const entries: CodingAssetEntry[] = [],
    states: [string, string][] = [];
  const aliases = new Map<string, { count: number; links: bigint }>();
  const inodes = new Map<string, { path: string; state: string }>();
  const buffer = Buffer.alloc(1048576),
    emptyName = Buffer.alloc(0);
  let bytes = 0,
    logicalBytes = 0,
    metadataBytes = selection ? Buffer.byteLength(JSON.stringify(selection.paths)) + 128 : 0,
    pendingNames = 0,
    pendingBytes = 0;
  const reserve = (stored = bytes, extraEntries = 0) =>
    account?.({
      stored,
      logical: logicalBytes,
      metadata: 4 * (metadataBytes + pendingBytes + 256),
      entries: entries.length + pendingNames + extraEntries,
    });
  const check = (stat: fs.BigIntStats) => {
    if (stat.uid !== BigInt(uid) || (stat.mode & 0o7000n) !== 0n)
      throw Error('unsupported_coding_asset');
  };
  const append = (entry: CodingAssetEntry, stat: fs.BigIntStats) => {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + codingAssetIdentity(stat).length;
    if (entries.length + pendingNames >= limits.entries || metadataBytes + pendingBytes > 33554432)
      throw Error('coding_asset_limit');
    reserve(bytes, 1);
    entries.push(entry);
    states.push([entry.path, codingAssetIdentity(stat)]);
  };
  const verifyPath = (fd: number, relative: string) => {
    if (codingAssetMount(fd) !== rootMount) throw Error('unsupported_coding_asset');
    if (fs.realpathSync(fdPath(fd)) !== (relative ? join(root, relative) : root))
      throw Error('stale_coding_asset');
  };
  const visit = (parent: number, name: string, relative: string, depth: number): void => {
    if (
      entries.length >= limits.entries ||
      depth > limits.depth ||
      Buffer.byteLength(relative) > 4096
    )
      throw Error('coding_asset_limit');
    const path = name ? join(fdPath(parent), name) : fdPath(parent);
    const before = name
      ? fs.lstatSync(path, { bigint: true })
      : fs.fstatSync(parent, { bigint: true });
    check(before);
    if (expected && expected.entries.get(relative) !== codingAssetIdentity(before))
      throw Error('stale_coding_asset');
    const guard = publications?.guards?.get(relative);
    checkAssetPolicy(policy, relative, before, !!publications?.candidates || !!guard);
    if (publications?.candidates && before.isFile() && before.nlink === 2n)
      publications.candidates.add(relative);
    if (selection && before.isDirectory() !== selection.children.has(relative))
      throw Error('invalid_coding_asset_selection');
    const mode = Number(before.mode & 0o777n);
    if (before.isSymbolicLink()) {
      const link = fs.openSync(path, 0x200000 | fs.constants.O_NOFOLLOW);
      try {
        same(before, fs.fstatSync(link, { bigint: true }));
        if (codingAssetMount(link) !== rootMount) throw Error('unsupported_coding_asset');
      } finally {
        fs.closeSync(link);
      }
      const target = text(fs.readlinkSync(path, { encoding: 'buffer' }));
      if (Buffer.byteLength(target) > 4096 || target.includes('\0'))
        throw Error('unsupported_coding_asset');
      same(before, fs.lstatSync(path, { bigint: true }));
      append({ path: relative, kind: 'symlink', target }, before);
      return;
    }
    if (before.isDirectory()) {
      const directory = name ? fs.openSync(path, directoryFlags) : parent;
      try {
        same(before, fs.fstatSync(directory, { bigint: true }));
        verifyPath(directory, relative);
        append({ path: relative, kind: 'directory', mode }, before);
        const names: Buffer[] = [];
        if (selection) {
          for (const child of selection.children.get(relative)!) {
            const raw = Buffer.from(child);
            names.push(raw);
            pendingNames++;
            pendingBytes += raw.length;
          }
        } else {
          const listing = fs.opendirSync(fdPath(directory), { encoding: 'latin1', bufferSize: 32 });
          try {
            for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) {
              const length = Buffer.byteLength(entry.name, 'latin1');
              if (
                pendingNames + entries.length >= limits.entries ||
                metadataBytes + pendingBytes + length > 33554432
              )
                throw Error('coding_asset_limit');
              pendingNames++;
              pendingBytes += length;
              reserve();
              // latin1 preserves raw name bytes so invalid UTF-8 cannot be silently replaced.
              names.push(Buffer.from(entry.name, 'latin1'));
            }
          } finally {
            listing.closeSync();
          }
        }
        names.sort((a, b) => Buffer.compare(a, b));
        for (let index = 0; index < names.length; index++) {
          const raw = names[index]!;
          names[index] = emptyName;
          pendingNames--;
          pendingBytes -= raw.length;
          const child = text(raw);
          if (
            !child ||
            child === '.' ||
            child === '..' ||
            child.includes('/') ||
            child.includes('\0')
          )
            throw Error('unsupported_coding_asset');
          visit(directory, child, relative ? relative + '/' + child : child, depth + 1);
        }
        same(before, fs.fstatSync(directory, { bigint: true }));
        verifyPath(directory, relative);
        if (name) same(before, fs.lstatSync(path, { bigint: true }));
      } finally {
        if (name) fs.closeSync(directory);
      }
      return;
    }
    if (!before.isFile()) throw Error('unsupported_coding_asset');
    const key = before.dev + ':' + before.ino,
      previous = inodes.get(key);
    if (
      (selection || policy === 'coding-dependency' || policy === 'desktop') &&
      policy !== 'classified-legacy' &&
      metadataOnly &&
      before.nlink > 1n
    ) {
      const group = aliases.get(key) ?? { count: 0, links: before.nlink };
      group.count++;
      aliases.set(key, group);
    }
    if (!previous && before.size > BigInt(limits.bytes - bytes)) throw Error('coding_asset_limit');
    logicalBytes += Number(before.size);
    reserve(bytes + (previous ? 0 : Number(before.size)));
    const file = fs.openSync(
      path,
      (metadataOnly ? 0x200000 : fs.constants.O_RDONLY) |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    try {
      same(before, fs.fstatSync(file, { bigint: true }));
      verifyPath(file, relative);
      if (previous) {
        if (previous.state !== codingAssetIdentity(before)) throw Error('stale_coding_asset');
        same(before, fs.lstatSync(path, { bigint: true }));
        append({ path: relative, kind: 'hardlink', target: previous.path }, before);
        return;
      }
      if (!metadataOnly) checkProfileArchiveFile(file);
      const size = Number(before.size);
      const hashBody = () => hashAssetBytes(file, metadataOnly ? 0 : size, buffer);
      const sha256 = guard ? guard.read(file, hashBody) : hashBody();
      same(before, fs.fstatSync(file, { bigint: true }));
      same(before, fs.lstatSync(path, { bigint: true }));
      verifyPath(file, relative);
      bytes += size;
      append({ path: relative, kind: 'file', mode, bytes: size, sha256 }, before);
      inodes.set(key, { path: relative, state: codingAssetIdentity(before) });
    } finally {
      fs.closeSync(file);
    }
  };
  try {
    rootMount = codingAssetMount(rootFd);
    if (expected && rootMount !== expected.mount) throw Error('stale_coding_asset');
    same(rootStat, fs.fstatSync(rootFd, { bigint: true }));
    visit(rootFd, '', '', 0);
    // The project name lives outside this traversal. Verify it and its actual bytes
    // again after visiting later scope entries, including the header.
    if (publications?.guards?.size)
      for (const entry of entries)
        if (entry.kind === 'file')
          publications.guards.get(entry.path)?.verify(entry.sha256, entry.bytes, buffer);
    same(rootStat, fs.lstatSync(root, { bigint: true }));
    verifyPath(rootFd, '');
    if ([...aliases.values()].some((alias) => BigInt(alias.count) !== alias.links))
      throw Error('protected_coding_asset');
    const body = {
      format: 1 as const,
      entries,
      bytes,
      ...(selection && { selectedFiles: selection.paths }),
    };
    return {
      root,
      policy,
      limits: { ...limits },
      manifest: { ...body, hash: hash(JSON.stringify(body)) },
      sourceStateHash: hash(JSON.stringify([root, rootMount, states])),
      sourceEntries: states,
      sourceMount: rootMount,
    };
  } finally {
    if (pinned === undefined) fs.closeSync(rootFd);
  }
}
