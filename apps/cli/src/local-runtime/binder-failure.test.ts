import type * as ChildProcess from 'node:child_process';
import type { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
let inject: ((program: string) => string) | undefined;
let replaceInterpreter: string | undefined;
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof ChildProcess>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof spawn>) => {
      if (args[0] === '/usr/bin/python3' && Array.isArray(args[1]) && inject) {
        return cp.spawn(replaceInterpreter ?? args[0], args[1].map(inject), args[2]);
      }
      return cp.spawn(...args);
    },
  };
});
it.each([
  'missing interpreter',
  'failed interpreter',
  'before transfer',
  'after transfer',
  'wrong listening inode',
  'transparent relay',
  'wrong peer',
  'short peer',
  'empty peer',
  'failed probe',
  ...['probe', 'peer'].flatMap((side) =>
    ['short', 'long', 'pid', 'uid', 'gid', 'unavailable'].map(
      (fault) => side + ' credential ' + fault,
    ),
  ),
])(
  'preserves unproved names and disposes the bootstrap and listener on %s failure',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-binder-')),
      profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', run);
    const rt = openOceanProfile(profile, true);
    await rt.ready;
    rt.close();
    const paths = localRuntimePaths(profile),
      original = join(root, 'original'),
      other = join(root, 'foreign');
    const substituted = mode === 'wrong listening inode' || mode === 'transparent relay';
    let observedChange: bigint | undefined;
    let received = 0,
      forwarding = mode === 'transparent relay';
    const foreign = createServer((left) => {
      if (substituted && observedChange === undefined)
        observedChange = lstatSync(paths.endpoint, { bigint: true }).ctimeNs;
      left.on('error', () => left.destroy());
      if (forwarding) {
        const right = connect(original);
        left.pipe(right);
        right.pipe(left);
        right.on('error', () => left.destroy());
        return;
      }
      left.on('data', (b: Buffer) => {
        received += b.length;
      });
      left.end('foreign');
    });
    try {
      foreign.listen(other);
      await once(foreign, 'listening');
      chmodSync(other, 0o600);
      const foreignInode = lstatSync(other).ino;
      if (mode === 'missing interpreter') replaceInterpreter = join(root, 'missing-python');
      inject = (program) => {
        if (mode === 'failed interpreter') return program.replace('signal.alarm(5)', 'sys.exit(1)');
        if (mode === 'before transfer')
          return program.replace('process.send([', 'process.exit(7); process.send([');
        if (mode === 'after transfer') return program.replace("ack === 'pinned' ? 0 : 1", '7');
        if (substituted)
          return program.replace(
            'pin = os.open',
            `os.rename(path,${JSON.stringify(original)})\nos.rename(${JSON.stringify(other)},path)\npin = os.open`,
          );
        if (mode.includes(' credential ')) {
          const [side, , fault] = mode.split(' ');
          const field = ['pid', 'uid', 'gid'].indexOf(fault!);
          let change = `parts=list(struct.unpack('=iII',value)); parts[${field}] ^= 1; return struct.pack('=iII',*parts)`;
          if (fault === 'short') change = 'return value[:-1]';
          if (fault === 'long') change = 'return value + bytes(1)';
          if (fault === 'unavailable') change = "raise OSError('SO_PEERCRED unavailable')";
          return program.replace(
            'signal.alarm(5)',
            `import struct
native_get = socket.socket.getsockopt
def corrupt(self, level, option, *args):
    value = native_get(self,level,option,*args)
    if level == socket.SOL_SOCKET and option == socket.SO_PEERCRED and self is ${side}:
        ${change}
    return value
socket.socket.getsockopt = corrupt
signal.alarm(5)`,
          );
        }
        if (mode === 'failed probe')
          return program.replace('probe.connect(', 'probe.close()\n    probe.connect(');
        if (mode.endsWith(' peer')) {
          const address =
            mode === 'short peer' ? 'address[:-1]' : 'address[:-1] + bytes([address[-1] ^ 1])';
          const bind = mode === 'empty peer' ? '' : `intruder.bind(${address})\n    `;
          return program.replace(
            'probe.connect(',
            `intruder = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n    ${bind}intruder.connect('/proc/self/fd/' + str(pin))\n    probe.connect(`,
          );
        }
        return program;
      };
      const startup = startLocalRuntime({ profile, provider: null }).then(async (host) => {
        await host.stop();
        await host.closed;
        return 'unexpectedly ready';
      });
      const expected =
        mode.endsWith('interpreter') || mode.endsWith('unavailable')
          ? 'endpoint_verification_unavailable'
          : mode.endsWith(' peer') || mode === 'transparent relay' || mode.includes(' credential ')
            ? 'endpoint_changed'
            : /^endpoint_/;
      await expect(startup).rejects.toThrow(expected);
      inject = undefined;
      replaceInterpreter = undefined;
      expect(existsSync(paths.descriptor)).toBe(false);
      if (mode.endsWith('interpreter')) {
        expect(existsSync(paths.endpoint)).toBe(false);
        const fresh = await startLocalRuntime({ profile, provider: null });
        expect((await fresh.stop()).outcome).toBe('complete');
        await fresh.closed;
      } else {
        const inode = lstatSync(paths.endpoint).ino;
        await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
          'endpoint_exists',
        );
        expect(lstatSync(paths.endpoint).ino).toBe(inode);
        const dead = connect(substituted ? original : paths.endpoint);
        try {
          await expect(once(dead, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        } finally {
          dead.destroy();
        }
        if (substituted) {
          expect(inode).toBe(foreignInode);
          expect(lstatSync(paths.endpoint, { bigint: true }).ctimeNs).toBe(observedChange);
          expect(lstatSync(paths.endpoint).mode & 0o777).toBe(0o600);
          forwarding = false;
          const socket = connect(paths.endpoint);
          expect(String((await once(socket, 'data'))[0])).toBe('foreign');
          socket.destroy();
          expect(received).toBe(0);
        }
      }
      const reopened = openOceanProfile(profile);
      await reopened.ready;
      reopened.close();
    } finally {
      inject = undefined;
      replaceInterpreter = undefined;
      await new Promise<void>((r) => foreign.close(() => r()));
      rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
