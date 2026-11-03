import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { localRuntimePaths, prepareLocalRuntimeDirectory } from '@runnets/tools-node';
import { openOceanProfile } from './profile.js';
import { profileCli } from '../../test-fixtures/profile-cli.test.js';
it('refuses peer-selected offline ownership and malformed status on the authenticated client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-hello-')),
    profile = join(root, 'p'),
    run = join(root, 'r');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const r = openOceanProfile(profile, true);
  await r.ready;
  r.close();
  const paths = localRuntimePaths(profile);
  prepareLocalRuntimeDirectory(paths);
  const instanceId = randomUUID();
  const identity = {
    profileId: paths.profileId,
    protocol: 1,
    instanceId,
    capabilities: ['status', 'stop'],
  };
  let respondStatus = false;
  const server = createServer((socket) => {
    socket.on('data', (b: Buffer) => {
      const { id, method } = JSON.parse(b.toString());
      socket.write(
        JSON.stringify(
          respondStatus
            ? { id, result: method === 'hello' ? identity : { ...identity, state: ['ready'] } }
            : { id, error: { code: 'runtime_absent' } },
        ) + '\n',
      );
    });
  });
  await new Promise<void>((r) => server.listen(paths.endpoint, r));
  chmodSync(paths.endpoint, 0o600);
  writeFileSync(
    paths.descriptor,
    JSON.stringify({
      profileId: paths.profileId,
      endpoint: paths.endpoint,
      protocol: 1,
      instanceId,
      capability: 'a'.repeat(64),
    }),
    { mode: 0o600 },
  );
  try {
    const cmd = await profileCli(profile, run)('init', '--workspace', root);
    expect(cmd).toMatchObject({ code: 3, reply: { ok: false, error: { code: 'runtime_absent' } } });
    respondStatus = true;
    expect(await profileCli(profile, run)('runtime', 'status')).toMatchObject({
      code: 2,
      reply: { error: { code: 'invalid_frame' } },
    });
    const check = openOceanProfile(profile);
    try {
      await check.ready;
      expect(check.conversations.bots('ws_ocean').ok).toBe(false);
    } finally {
      check.close();
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
