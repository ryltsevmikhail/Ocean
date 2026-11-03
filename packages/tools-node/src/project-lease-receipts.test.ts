import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { ProjectLease } from '@runnets/domain';
import type { CodingFinalizationReleaseIntent } from '@runnets/domain';
import { SqliteProjectLeases } from './project-leases.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const holder = (id: string) => ({
  ownerId: id,
  taskId: id,
  requestId: id,
  binding: id,
  kind: 'coding' as const,
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-lease-receipts-'));
  roots.push(root);
  return {
    root,
    directory: join(root, 'registry'),
    leases: new SqliteProjectLeases(join(root, 'registry')),
  };
}
function intent(lease: ProjectLease, operationId = 'finalize-1'): CodingFinalizationReleaseIntent {
  return {
    operationId,
    bindingDigest: 'a'.repeat(64),
    taskId: lease.taskId,
    workspaceId: 'ws_ocean',
    ownerId: lease.ownerId,
    projectRoot: lease.projectRoot,
    tokenHash: hex(lease.token),
    holderHash: hex(JSON.stringify(lease)),
    releasedAt: '2026-11-03T00:00:00.000Z',
  };
}
it('durably proves the exact token release and reads it back across adapters', () => {
  const { directory, leases } = setup();
  const acquired = leases.acquire('/project', holder('owner'));
  if (!acquired.ok) throw Error('fixture');
  const lease = acquired.value;
  const outcome = leases.releaseExact(lease, intent(lease));
  expect(outcome.outcome).toBe('released');
  expect(leases.owns(lease)).toBe(false);
  const other = new SqliteProjectLeases(directory);
  expect(other.releaseReceipt('finalize-1')).toMatchObject({
    operationId: 'finalize-1',
    taskId: lease.taskId,
    tokenHash: hex(lease.token),
    registry: { path: join(directory, 'leases.sqlite') },
  });
  // Repeating the exact same operation proves the same receipt and deletes nothing.
  expect(other.releaseExact(lease, intent(lease))).toMatchObject({ outcome: 'released' });
  expect(other.releaseExact(lease, intent(lease, 'finalize-2'))).toMatchObject({
    outcome: 'absent',
  });
});
it('distinguishes token absence, mismatch, receipt conflict and a later holder', () => {
  const { directory, leases } = setup();
  const acquired = leases.acquire('/project', holder('owner'));
  if (!acquired.ok) throw Error('fixture');
  const lease = acquired.value;
  const absent = new SqliteProjectLeases(directory).releaseExact(
    { ...lease, token: 'not-present' },
    intent({ ...lease, token: 'not-present' }, 'finalize-absent'),
  );
  expect(absent).toEqual({ outcome: 'absent' });
  expect(leases.owns(lease)).toBe(true);
  // A changed holder under the old token is a mismatch, never a release.
  const db = new DatabaseSync(join(directory, 'leases.sqlite'));
  try {
    db.prepare('UPDATE project_leases_v1 SET payload=? WHERE token=?').run(
      JSON.stringify({ ...lease, binding: 'changed' }),
      lease.token,
    );
  } finally {
    db.close();
  }
  expect(leases.releaseExact(lease, intent(lease, 'finalize-mismatch'))).toEqual({
    outcome: 'mismatch',
    detail: 'holder_changed',
  });
  expect(leases.owns(lease)).toBe(false);
  const cleanup = new DatabaseSync(join(directory, 'leases.sqlite'));
  try {
    cleanup.prepare('DELETE FROM project_leases_v1 WHERE token=?').run(lease.token);
  } finally {
    cleanup.close();
  }
  const fresh = leases.acquire('/project', holder('fresh'));
  expect(fresh.ok).toBe(true);
  expect(leases.releaseExact(lease, intent(lease, 'finalize-old'))).toEqual({ outcome: 'absent' });
  if (fresh.ok) expect(leases.owns(fresh.value)).toBe(true);
});
it('fails closed on a missing or corrupt registry and creates or deletes nothing', () => {
  const { root, directory, leases } = setup();
  const acquired = leases.acquire('/project', holder('owner'));
  if (!acquired.ok) throw Error('fixture');
  const lease = acquired.value;
  const missing = new SqliteProjectLeases(join(root, 'absent-registry'));
  expect(missing.releaseExact(lease, intent(lease))).toEqual({
    outcome: 'registry_missing',
    detail: 'registry_absent',
  });
  expect(existsSync(join(root, 'absent-registry'))).toBe(false);
  leases.release(lease);
  rmSync(join(directory, 'leases.sqlite'));
  writeFileSync(join(directory, 'leases.sqlite'), 'not sqlite', { mode: 0o600 });
  expect(leases.releaseExact(lease, intent(lease))).toMatchObject({
    outcome: 'registry_corrupt',
  });
  expect(existsSync(join(directory, 'leases.sqlite'))).toBe(true);
});
it('never treats a fresh holder of the same root as the old absent token', () => {
  const { leases } = setup();
  const acquired = leases.acquire('/project', holder('owner'));
  if (!acquired.ok) throw Error('fixture');
  const lease = acquired.value;
  expect(leases.release(lease)).toBe(true);
  const later = leases.acquire('/project', holder('later'));
  if (!later.ok) throw Error('later');
  expect(leases.releaseExact(lease, intent(lease))).toEqual({ outcome: 'absent' });
  expect(leases.owns(later.value)).toBe(true);
  expect(leases.releaseReceipt('finalize-1')).toBeNull();
});
