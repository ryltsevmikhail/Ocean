import type * as ChildProcess from 'node:child_process';
import type { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
let inject: ((program: string) => string) | undefined;
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof ChildProcess>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof spawn>) => {
      if (inject && Array.isArray(args[1]) && args[1][0] === '-e')
        return cp.spawn(args[0], ['-e', inject(String(args[1][1]))], args[2]);
      return cp.spawn(...args);
    },
  };
});
it.each(['before transfer', 'after transfer', 'wrong listening inode'])(
  'closes the passed handle and reaps the helper on %s failure',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-binder-')),
      profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', run);
    const rt = openOceanProfile(profile, true);
    await rt.ready;
    rt.close();
    const paths = localRuntimePaths(profile);
    const original = join(root, 'original'),
      other = join(root, 'foreign');
    let received = 0;
    const foreign = createServer((socket) => {
      socket.on('data', (b: Buffer) => {
        received += b.length;
      });
      socket.end('foreign');
    });
    try {
      foreign.listen(other);
      await once(foreign, 'listening');
      inject = (program) => {
        if (mode === 'before transfer')
          return program.replace('process.send([', 'process.exit(7); process.send([');
        if (mode === 'after transfer') return program.replace("ack === 'pinned' ? 0 : 1", '7');
        return program.replace(
          'const pin =',
          `require('node:fs').renameSync(path,${JSON.stringify(original)});require('node:fs').renameSync(${JSON.stringify(other)},path);const pin =`,
        );
      };
      await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
        /endpoint_(exists|changed)/,
      );
      inject = undefined;
      expect(existsSync(paths.descriptor)).toBe(false);
      const inode = lstatSync(paths.endpoint).ino;
      await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
        'endpoint_exists',
      );
      expect(lstatSync(paths.endpoint).ino).toBe(inode);
      const dead = connect(mode === 'wrong listening inode' ? original : paths.endpoint);
      try {
        await expect(once(dead, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      } finally {
        dead.destroy();
      }
      if (mode === 'wrong listening inode') {
        const socket = connect(paths.endpoint);
        expect(String((await once(socket, 'data'))[0])).toBe('foreign');
        socket.destroy();
        expect(received).toBe(0);
      }
      const reopened = openOceanProfile(profile);
      await reopened.ready;
      reopened.close();
    } finally {
      inject = undefined;
      await new Promise<void>((r) => foreign.close(() => r()));
      rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
