import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodingAssetCapture } from './coding-asset-state.js';
export interface ProfileBackupLimits {
  readonly stored: number;
  readonly logical: number;
  readonly entries: number;
  readonly metadata: number;
}
export const PROFILE_BACKUP_LIMITS: ProfileBackupLimits = {
  stored: 2147483648,
  logical: 2147483648,
  entries: 100000,
  metadata: 33554432,
};
export class ProfileBackupBudget {
  readonly limits: ProfileBackupLimits;
  readonly #charges = new Map<string, ProfileBackupLimits>();
  readonly #total = { stored: 0, logical: 0, entries: 0, metadata: 0 };
  constructor(options: Partial<ProfileBackupLimits> = {}) {
    this.limits = { ...PROFILE_BACKUP_LIMITS, ...options };
    for (const key of Object.keys(this.limits) as (keyof ProfileBackupLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 0 ||
        this.limits[key] > PROFILE_BACKUP_LIMITS[key]
      )
        throw Error('profile_backup_limit');
  }
  charge(key: string, values: Partial<ProfileBackupLimits>): void {
    const previous = this.#charges.get(key) ?? { stored: 0, logical: 0, entries: 0, metadata: 0 };
    const next = { ...previous };
    for (const field of Object.keys(this.limits) as (keyof ProfileBackupLimits)[]) {
      const value = values[field] ?? previous[field];
      if (!Number.isSafeInteger(value) || value < 0) throw Error('profile_backup_limit');
      next[field] = Math.max(value, previous[field]);
      if (this.#total[field] + next[field] - previous[field] > this.limits[field])
        throw Error('profile_backup_limit');
    }
    for (const field of Object.keys(this.limits) as (keyof ProfileBackupLimits)[])
      this.#total[field] += next[field] - previous[field];
    this.#charges.set(key, next);
  }
}
interface Observation {
  metadata(): void;
  bytes(): void;
  close(): void;
}
/** One private source lifetime; all metadata checks precede any final byte checks. */
export class ProfileBackupSession {
  readonly budget: ProfileBackupBudget;
  readonly #roots = new Map<string, CodingAssetCapture>();
  readonly #held = new Map<string, Observation>();
  readonly #digests = new Map<string, string>();
  #checking = false;
  #closed = false;
  constructor(limits?: Partial<ProfileBackupLimits>) {
    this.budget = new ProfileBackupBudget(limits);
  }
  plan(metadata: CodingAssetCapture, observation: Observation): void {
    if (this.#roots.has(metadata.root)) throw Error('overlapping_profile_asset_selection');
    this.budget.charge('source:' + metadata.root, {
      stored: metadata.manifest.bytes,
      logical: metadata.manifest.entries.reduce((total, entry) => {
        const target =
          entry.kind === 'hardlink'
            ? metadata.manifest.entries.find((e) => e.path === entry.target)
            : entry;
        return total + (target?.kind === 'file' ? target.bytes : 0);
      }, 0),
      entries: metadata.manifest.entries.length,
      metadata: Buffer.byteLength(JSON.stringify(metadata)),
    });
    this.#roots.set(metadata.root, structuredClone(metadata));
    this.#held.set('plan:' + metadata.root, observation);
  }
  admit(metadata: CodingAssetCapture): void {
    if (this.#checking) return;
    const original = this.#roots.get(metadata.root);
    if (!original || metadata.sourceMount !== original.sourceMount)
      throw Error('unplanned_profile_asset');
    const states = new Map(original.sourceEntries);
    if (metadata.sourceEntries.some(([path, state]) => states.get(path) !== state))
      throw Error('stale_coding_asset');
    if (!metadata.manifest.selectedFiles && metadata.sourceStateHash !== original.sourceStateHash)
      throw Error('stale_coding_asset');
  }
  retain(key: string, digest: string, observation: Observation): void {
    if (this.#closed) throw Error('closed_profile_backup');
    const previous = this.#digests.get(key);
    if (this.#checking || previous !== undefined) {
      observation.close();
      if (previous !== undefined && previous !== digest) throw Error('stale_coding_asset');
      return;
    }
    this.#digests.set(key, digest);
    this.#held.set(key, observation);
  }
  checkMetadata(): void {
    if (this.#closed) throw Error('closed_profile_backup');
    for (const source of this.#held.values()) source.metadata();
  }
  verify(): void {
    if (this.#closed) throw Error('closed_profile_backup');
    this.#checking = true;
    try {
      this.checkMetadata();
      for (const source of this.#held.values()) source.bytes();
      for (const source of this.#held.values()) source.metadata();
    } finally {
      this.#checking = false;
    }
  }
  close(): void {
    this.#closed = true;
    for (const source of [...this.#held.values()].reverse()) source.close();
    this.#held.clear();
  }
}
export const profileBackupSession = new AsyncLocalStorage<ProfileBackupSession>();
