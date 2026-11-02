import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodingAssetManifest } from '@runnets/domain';
import type { CodingAssetPolicy } from './coding-asset-policy.js';
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

export interface CodingAssetCapture {
  readonly policy: CodingAssetPolicy;
  readonly limits: CodingAssetLimits;
  readonly root: string;
  readonly manifest: CodingAssetManifest;
  readonly sourceStateHash: string;
  readonly sourceMount: string;
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
export function codingAssetMount(fd: number): string {
  const info = fs.readFileSync('/proc/self/fdinfo/' + String(fd), 'utf8');
  const value = /^mnt_id:\s+(\d+)$/m.exec(info)?.[1];
  if (!value) throw Error('unsupported_coding_asset');
  return value;
}

/** Host-only guards issued by the scoped classifier. Never serialized to a portable manifest. */
export interface PublicationGuard {
  read<T>(staged: number, consume: () => T): T;
  verify(sha256: string, bytes: number, buffer: Buffer): void;
}
export type PublicationGuards = ReadonlyMap<string, PublicationGuard>;

/** Caller pins and checks the descriptor and charges the complete byte budget before reading. */
export function hashAssetBytes(fd: number, bytes: number, buffer: Buffer) {
  const digest = createHash('sha256');
  let position = 0;
  while (position < bytes) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
    if (!count) throw Error('stale_coding_asset');
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest('hex');
}
