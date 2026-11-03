import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProfileRebindRecord, RestoreOrigin } from '@runnets/domain';
import { verifyRuntimeEpoch } from './runtime-epoch.js';
interface Guard {
  state: 'ready';
  format?: 1 | 2;
  sha256?: string;
  snapshotAt?: string;
}
export type RestoreGuardInspection =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ready'; readonly guard: Guard };
const present = (path: string) => fs.lstatSync(path, { throwIfNoEntry: false });
export function runtimeIncomplete(profile: string): boolean {
  return present(join(profile, '.incomplete')) !== undefined;
}
export function restoreMarkerPresent(profile: string): boolean {
  return present(join(profile, 'restore-guard.json')) !== undefined;
}
/** Bounded metadata admission precedes any body read or writable SQLite open. */
export function inspectRuntimeRestoreGuard(profile: string): RestoreGuardInspection {
  if (runtimeIncomplete(profile)) throw Error('recovery_required');
  const path = join(profile, 'restore-guard.json'),
    before = present(path);
  if (!before) return { kind: 'none' };
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    before.mode & 0o077 ||
    before.size > 4096 ||
    before.size < 2 ||
    fs.realpathSync(path) !== path
  )
    return { kind: 'invalid' };
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const pinned = fs.fstatSync(fd),
      bytes = Buffer.alloc(before.size);
    if (pinned.dev !== before.dev || pinned.ino !== before.ino || pinned.size !== before.size)
      return { kind: 'invalid' };
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { kind: 'invalid' };
    const value = JSON.parse(bytes.toString('utf8')) as Guard;
    const after = fs.lstatSync(path);
    if (
      value?.state !== 'ready' ||
      (value.format !== undefined && value.format !== 1 && value.format !== 2) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return { kind: 'invalid' };
    return { kind: 'ready', guard: value };
  } catch {
    return { kind: 'invalid' };
  } finally {
    fs.closeSync(fd);
  }
}
/** Strict form for CLI admission; invalid guards stay refused rather than downgraded. */
export function runtimeRestoreGuard(profile: string): Guard | null {
  const inspection = inspectRuntimeRestoreGuard(profile);
  if (inspection.kind === 'invalid') throw Error('recovery_required');
  return inspection.kind === 'ready' ? inspection.guard : null;
}
/**
 * Durable 7.9 origins require the exact bound guard. Legacy profiles keep their
 * historical text-only marker semantics; neither can grant executable authority.
 */
export function restoredRuntimeAdmission(
  profile: string,
  origin: RestoreOrigin | null,
  allowed: boolean | undefined,
  active: ProfileRebindRecord | null = null,
): boolean {
  const inspection = inspectRuntimeRestoreGuard(profile);
  if (origin) {
    const guard = inspection.kind === 'ready' ? inspection.guard : null;
    if (
      !guard ||
      (!allowed && !active) ||
      origin.profileRoot !== fs.realpathSync(profile) ||
      origin.profileId !== createHash('sha256').update(profile).digest('hex') ||
      guard.format !== 2 ||
      guard.sha256 !== origin.manifest.sha256 ||
      guard.snapshotAt !== origin.manifest.createdAt
    )
      throw Error('restore_restricted');
    if (active) {
      verifyRuntimeEpoch(profile, origin, active);
      return false;
    }
    return true;
  }
  if (active) throw Error('invalid_execution_epoch');
  if (inspection.kind !== 'none' && !allowed) throw Error('restore_restricted');
  return inspection.kind !== 'none';
}
