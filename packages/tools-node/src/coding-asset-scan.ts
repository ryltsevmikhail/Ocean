import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingAssetEntry, CodingAssetManifest } from '@runnets/domain';
import { checkAssetPolicy, type CodingAssetPolicy } from './coding-asset-policy.js';
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const fdPath = (fd: number) => '/proc/self/fd/' + String(fd);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CodingAssetLimits {
  readonly bytes: number;
  readonly entries: number;
  readonly depth: number;
}
export const CODING_ASSET_LIMITS: CodingAssetLimits = {
  bytes: 2147483648,
  entries: 100000,
  depth: 128,
};
export type { CodingAssetPolicy } from './coding-asset-policy.js';
export interface CodingAssetCapture {
  readonly policy: CodingAssetPolicy;
  readonly limits: CodingAssetLimits;
  readonly root: string;
  readonly manifest: CodingAssetManifest;
  readonly sourceStateHash: string;
  readonly sourceEntries: readonly (readonly [string, string])[];
}
export function codingAssetIdentity(stat: fs.BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}
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
export function codingAssetMount(fd: number): string {
  const info = fs.readFileSync('/proc/self/fdinfo/' + String(fd), 'utf8');
  const value = /^mnt_id:\s+(\d+)$/m.exec(info)?.[1];
  if (!value) throw Error('unsupported_coding_asset');
  return value;
}
function scan(
  root: string,
  limits: CodingAssetLimits,
  policy: CodingAssetPolicy,
  expected?: ReadonlyMap<string, string>,
  metadataOnly = false,
  pinned?: number,
): CodingAssetCapture {
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || uid === undefined || fs.realpathSync(root) !== root)
    throw Error('unsupported_coding_asset');
  const rootStat = fs.lstatSync(root, { bigint: true });
  const rootFd = pinned ?? fs.openSync(root, directoryFlags);
  let rootMount = '';
  const entries: CodingAssetEntry[] = [],
    states: [string, string][] = [];
  const inodes = new Map<string, { path: string; state: string }>();
  const buffer = Buffer.alloc(1048576),
    emptyName = Buffer.alloc(0);
  let bytes = 0,
    metadataBytes = 0,
    pendingNames = 0,
    pendingBytes = 0;
  const check = (stat: fs.BigIntStats) => {
    if (stat.uid !== BigInt(uid) || (stat.mode & 0o7000n) !== 0n)
      throw Error('unsupported_coding_asset');
  };
  const append = (entry: CodingAssetEntry, stat: fs.BigIntStats) => {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + codingAssetIdentity(stat).length;
    if (entries.length + pendingNames >= limits.entries || metadataBytes + pendingBytes > 33554432)
      throw Error('coding_asset_limit');
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
    if (expected && expected.get(relative) !== codingAssetIdentity(before))
      throw Error('stale_coding_asset');
    checkAssetPolicy(policy, relative, before);
    const mode = Number(before.mode & 0o777n);
    if (before.isSymbolicLink()) {
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
            // latin1 preserves raw name bytes so invalid UTF-8 cannot be silently replaced.
            names.push(Buffer.from(entry.name, 'latin1'));
          }
        } finally {
          listing.closeSync();
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
    if (!previous && before.size > BigInt(limits.bytes - bytes)) throw Error('coding_asset_limit');
    const file = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
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
      const digest = createHash('sha256');
      let position = metadataOnly ? Number(before.size) : 0;
      while (position < Number(before.size)) {
        const count = fs.readSync(
          file,
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - position),
          position,
        );
        if (count === 0) throw Error('stale_coding_asset');
        digest.update(buffer.subarray(0, count));
        position += count;
      }
      same(before, fs.fstatSync(file, { bigint: true }));
      same(before, fs.lstatSync(path, { bigint: true }));
      verifyPath(file, relative);
      bytes += position;
      append(
        { path: relative, kind: 'file', mode, bytes: position, sha256: digest.digest('hex') },
        before,
      );
      inodes.set(key, { path: relative, state: codingAssetIdentity(before) });
    } finally {
      fs.closeSync(file);
    }
  };
  try {
    rootMount = codingAssetMount(rootFd);
    same(rootStat, fs.fstatSync(rootFd, { bigint: true }));
    visit(rootFd, '', '', 0);
    same(rootStat, fs.lstatSync(root, { bigint: true }));
    verifyPath(rootFd, '');
    const body = { format: 1 as const, entries, bytes };
    return {
      root,
      policy,
      limits: { ...limits },
      manifest: { ...body, hash: hash(JSON.stringify(body)) },
      sourceStateHash: hash(JSON.stringify([root, states])),
      sourceEntries: states,
    };
  } finally {
    if (pinned === undefined) fs.closeSync(rootFd);
  }
}
/** Captures a selected root only. Symlinks are inert text; a separate graph resolver must prove completeness. */
export function captureCodingAssetTree(
  root: string,
  options: Partial<CodingAssetLimits> = {},
  policy: CodingAssetPolicy = 'all',
): CodingAssetCapture {
  return captureAssetTreeAt(root, options, policy);
}
/** Internal entry point for a source already pinned by a trusted collector. */
export function captureAssetTreeAt(
  root: string,
  options: Partial<CodingAssetLimits>,
  policy: CodingAssetPolicy,
  pinned?: number,
  preflight?: (metadata: CodingAssetCapture) => void,
): CodingAssetCapture {
  if (!['all', 'coding-worktree', 'coding-recovery', 'coding-recovery-v2'].includes(policy))
    throw Error('unsupported_coding_asset');
  const limits = { ...CODING_ASSET_LIMITS, ...options };
  for (const key of ['bytes', 'entries', 'depth'] as const)
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < (key === 'entries' ? 1 : 0) ||
      limits[key] > CODING_ASSET_LIMITS[key]
    )
      throw Error('coding_asset_limit');
  const metadata =
    policy !== 'all' ? scan(root, limits, policy, undefined, true, pinned) : undefined;
  if (metadata) preflight?.(metadata);
  const expected = metadata && new Map(metadata.sourceEntries);
  const first = scan(root, limits, policy, expected, false, pinned),
    second = scan(root, limits, policy, expected, false, pinned);
  if (
    first.manifest.hash !== second.manifest.hash ||
    first.sourceStateHash !== second.sourceStateHash
  )
    throw Error('stale_coding_asset');
  return first;
}
/** Verify captured bytes as well as source identities after consuming the evidence. */
export function checkAssetTreeAt(capture: CodingAssetCapture, pinned: number): void {
  const after = scan(
    capture.root,
    capture.limits,
    capture.policy,
    new Map(capture.sourceEntries),
    false,
    pinned,
  );
  if (
    after.sourceStateHash !== capture.sourceStateHash ||
    after.manifest.hash !== capture.manifest.hash
  )
    throw Error('stale_coding_asset');
}
