import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeBackend } from './native.js';
import { SqliteProjectLeases } from './project-leases.js';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it('pre-cancelled legacy command neither spawns nor leaves a mutation reservation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-pre-cancel-'));
  roots.push(root);
  const leases = new SqliteProjectLeases(join(root, 'registry')),
    backend = await createNativeBackend(root, { leases });
  const controller = new AbortController();
  controller.abort();
  await expect(
    backend.command(process.execPath, ['-e', 'process.exit(0)'], '.', controller.signal),
  ).rejects.toThrow();
  expect(
    leases.acquire(root, {
      ownerId: 'one',
      taskId: 'task',
      requestId: 'start',
      binding: 'binding',
      kind: 'coding',
    }).ok,
  ).toBe(true);
});

it('invalid cwd or stale pre-write content cannot strand a reservation before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-invalid-mutation-'));
  roots.push(root);
  const leases = new SqliteProjectLeases(join(root, 'registry')),
    backend = await createNativeBackend(root, { leases });
  await expect(
    backend.command(
      process.execPath,
      ['-e', 'process.exit(0)'],
      'missing-dir',
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(backend.write('missing-file', 'new', 'expected-old')).rejects.toThrow('changed');
  expect(
    leases.acquire('/another-project', {
      ownerId: 'next',
      taskId: 'task',
      requestId: 'start',
      binding: 'binding',
      kind: 'coding',
    }).ok,
  ).toBe(true);
});
