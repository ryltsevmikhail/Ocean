import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from './profile.js';
import { child, profileCli } from '../../test-fixtures/profile-cli.test.js';
it('refuses offline recovery with a stale publication proof even if the endpoint directory was erased', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-lost-')),
    profile = join(root, 'p'),
    run = join(root, 'r');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  runtime.close();
  const owner = child(['runtime', 'start', '--profile', profile], { XDG_RUNTIME_DIR: run }),
    cli = profileCli(profile, run);
  try {
    await vi.waitFor(() => expect(owner.out()).toContain('"ready"'));
    owner.proc.kill('SIGKILL');
    await owner.exit;
    const p = localRuntimePaths(profile);
    expect((await cli('init', '--workspace', root)).reply.error.code).toBe('runtime_unreachable');
    rmSync(p.directory, { recursive: true });
    for (const args of [
      ['init', '--workspace', root],
      ['backup', '--to', join(root, 'archive')],
      ['doctor'],
    ]) {
      expect((await cli(...args)).reply.error?.code).toBe('endpoint_exists');
    }
    const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM ocean_workspace').get()?.['n']).toBe(0);
    } finally {
      db.close();
    }
    mkdirSync(p.directory, { mode: 0o700 });
    writeFileSync(join(p.directory, 'partial'), 'unattested');
    expect((await cli('init', '--workspace', root)).reply.error.code).toBe('endpoint_exists');
  } finally {
    owner.proc.kill('SIGKILL');
    await owner.exit;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
it('an owner starting after the absence probe wins the SQLite transaction before offline recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-race-')),
    profile = join(root, 'p'),
    run = join(root, 'r');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const r = openOceanProfile(profile, true);
  await r.ready;
  r.close();
  const { connectPublishedRuntime } = await import('@runnets/tools-node');
  expect(connectPublishedRuntime(profile)).toBeNull();
  const owner = child(['runtime', 'start', '--profile', profile], { XDG_RUNTIME_DIR: run });
  try {
    await vi.waitFor(() => expect(owner.out()).toContain('"ready"'));
    expect(() => openOceanProfile(profile, false, { requireUnpublished: true })).toThrow(
      expect.objectContaining({ code: 'owner_busy' }),
    );
    expect((await profileCli(profile, run)('runtime', 'stop')).code).toBe(0);
  } finally {
    owner.proc.kill('SIGKILL');
    await owner.exit;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
