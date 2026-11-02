import * as fs from 'node:fs';
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
