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

it('only attested runtime restart may recover the published profile after a real SIGKILL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-acp-crash-')),
    profile = join(root, 'p'),
    run = join(root, 'r'),
    path = join(profile, 'runtime.sqlite');
  mkdirSync(run, { mode: 0o700 });
  const offline = openOceanProfile(profile, true);
  await offline.ready;
  offline.close();
  const env = { XDG_RUNTIME_DIR: run },
    owner = child(['runtime', 'start', '--profile', profile], env);
  let successor: ReturnType<typeof child> | undefined;
  try {
    await vi.waitFor(() => expect(owner.out()).toContain('"ready"'), { timeout: 5000 });
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO tool_invocations_v1 VALUES ('probe','synthetic','started')").run();
    } finally {
      db.close();
    }
    owner.proc.kill('SIGKILL');
    await owner.exit;
    const facts = () => {
      const reader = new DatabaseSync(path, { readOnly: true });
      try {
        return {
          owner: reader.prepare('SELECT owner,pid FROM runtime_owner_v1').get(),
          proof: reader.prepare('SELECT digest FROM local_endpoint_v1').get(),
          effect: reader.prepare("SELECT outcome FROM tool_invocations_v1 WHERE id='probe'").get(),
        };
      } finally {
        reader.close();
      }
    };
    const before = facts();
    expect(before).toMatchObject({
      owner: { pid: owner.proc.pid },
      proof: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      effect: { outcome: 'started' },
    });
    for (const args of [
      ['acp'],
      ['status'],
      ['tui', '--cwd', root],
      ['task', '--cwd', root, 'fixture'],
    ]) {
      const legacy = child(args, {
        ...env,
        RUNNE_DB: path,
        ...(args[0] === 'task'
          ? {
              DEEPSEEK_API_KEY: 'synthetic-fixture',
              NODE_OPTIONS:
                '--import=data:text/javascript,globalThis.fetch%3D()%3D%3Eprocess.exit(88)',
            }
          : {}),
      });
      legacy.proc.stdin.end(
        args[0] === 'acp'
          ? JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { protocolVersion: 1 },
            }) + '\n'
          : '',
      );
      expect(await legacy.exit, args[0]).toBe(3);
      expect(legacy.err().trim()).toBe('endpoint_exists');
      expect(legacy.out()).toBe('');
      expect(facts()).toEqual(before);
    }
    successor = child(['runtime', 'start', '--profile', profile], env);
    await vi.waitFor(() => expect(successor!.out()).toContain('"ready"'), { timeout: 5000 });
    expect(facts().effect).toMatchObject({ outcome: 'uncertain' });
    expect((await profileCli(profile, run)('runtime', 'stop')).code).toBe(0);
    expect(await successor.exit).toBe(0);
  } finally {
    owner.proc.kill('SIGKILL');
    await owner.exit;
    if (successor) {
      successor.proc.kill('SIGKILL');
      await successor.exit;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
