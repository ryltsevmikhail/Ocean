import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SqliteProjectLeases } from './project-leases.js';

it('waits for a real exclusive database lock during registry initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ocean-lease-busy-'));
  const registry = new SqliteProjectLeases(directory);
  const holder = {
    ownerId: 'test',
    taskId: 'test',
    requestId: 'test',
    binding: 'test',
    kind: 'coding' as const,
  };
  const first = registry.acquire('/project', holder);
  if (!first.ok) throw Error('fixture');
  registry.release(first.value);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
  `,
      join(directory, 'leases.sqlite'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(Error('lock worker failed'));
      });
    });
    const second = registry.acquire('/project', holder);
    expect(second.ok).toBe(true);
    if (second.ok) registry.release(second.value);
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
