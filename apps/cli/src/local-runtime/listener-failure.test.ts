import type * as FileSystem from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { once } from 'node:events';
import { localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, chmodSync: vi.fn(fs.chmodSync) };
});
it.each([false, true])(
  'disposes the bound listener on chmod failure with replacement=%s',
  async (replace) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-bind-')),
      profile = join(root, 'profile');
    const run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', run);
    const r = openOceanProfile(profile, true);
    await r.ready;
    r.close();
    const paths = localRuntimePaths(profile);
    const moved = join(paths.directory, 'original');
    try {
      vi.mocked(chmodSync).mockImplementationOnce(() => {
        if (replace) {
          renameSync(paths.endpoint, moved);
          writeFileSync(paths.endpoint, 'foreign', { mode: 0o600 });
        }
        throw Error('chmod fault');
      });
      await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow('chmod fault');
      if (replace) expect(readFileSync(paths.endpoint, 'utf8')).toBe('foreign');
      else expect(existsSync(paths.endpoint)).toBe(false);
      const s = connect(replace ? moved : paths.endpoint);
      try {
        await expect(once(s, 'connect')).rejects.toMatchObject({
          code: replace ? 'ECONNREFUSED' : 'ENOENT',
        });
      } finally {
        s.destroy();
      }
      const reopened = openOceanProfile(profile);
      await reopened.ready;
      reopened.close();
    } finally {
      vi.mocked(chmodSync).mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
