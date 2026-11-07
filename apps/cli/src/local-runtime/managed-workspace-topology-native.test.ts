import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedNativeFixture } from '../../test-fixtures/managed-workspace-native.ts';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1').each(['alias', 'directory', 'file'])(
  'refuses a real kernel %s import before native process launch',
  async (mode) => {
    const f = await managedNativeFixture();
    const profile = mkdtempSync(join(tmpdir(), 'managed-topology-profile-'));
    try {
      const result = await promisify(execFile)(
        '/usr/bin/unshare',
        [
          '--user',
          '--map-root-user',
          '--mount',
          '--propagation',
          'private',
          process.execPath,
          fileURLToPath(
            new URL('../../test-fixtures/managed-workspace-topology.ts', import.meta.url),
          ),
          f.proof,
          mode,
          f.artifact,
          f.digest,
          profile,
        ],
        { env: process.env, timeout: 10000 },
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode,
        startup: 0,
        mountWitness: expect.any(Array),
      });
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  },
  15000,
);
