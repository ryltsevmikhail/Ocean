import * as cp from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';

let inject: ((program: string) => string) | undefined;
vi.mock('node:child_process', async (original) => {
  const child = await original<typeof cp>();
  return {
    ...child,
    spawn: (...args: Parameters<typeof cp.spawn>) => {
      if (args[0] === '/usr/bin/python3' && Array.isArray(args[1]) && inject)
        return child.spawn(args[0], args[1].map(inject), args[2]);
      return child.spawn(...args);
    },
  };
});
const copyPeer = String.raw`
import json, os, signal, socket, sys
signal.alarm(10)
foreign, original, endpoint, evidence = sys.argv[1:]
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
    server.bind(foreign)
    os.chmod(foreign, 0o600)
    server.listen()
    print(json.dumps([os.readlink('/proc/self/ns/net'),os.readlink('/proc/self/ns/pid'),os.getpid(),os.geteuid()]), flush=True)
    client, incoming_address = server.accept()
    with client, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as other:
        other.bind(incoming_address)
        with open(evidence, 'w') as record:
            json.dump([other.getsockname() == incoming_address,str(os.stat(endpoint).st_ctime_ns)],record)
        other.connect(original)
    # No probe bytes are read or forwarded. Stay live for a separate preservation check.
    followup, _ = server.accept()
    with followup:
        followup.sendall(b'foreign listener')
`;
it.runIf(
  process.platform === 'linux' &&
    process.getuid?.() !== 0 &&
    process.env['OCEAN_SANDBOX_NATIVE'] === '1',
)(
  'refuses a live foreign process that copies the full probe address in another network namespace',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-peer-ns-')),
      profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', run);
    const offline = openOceanProfile(profile, true);
    await offline.ready;
    offline.close();
    const paths = localRuntimePaths(profile);
    const original = join(root, 'original'),
      foreign = join(root, 'foreign'),
      evidence = join(root, 'foreign-proof'),
      kernel = join(root, 'accepted-proof');
    const processF = cp.spawn(
      'unshare',
      [
        '--user',
        '--map-root-user',
        '--net',
        '--pid',
        '--fork',
        '--kill-child',
        '/usr/bin/python3',
        '-I',
        '-S',
        '-c',
        copyPeer,
        foreign,
        original,
        paths.endpoint,
        evidence,
      ],
      {
        env: {
          ...Object.fromEntries(
            [
              'HOME',
              'XDG_RUNTIME_DIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'XDG_STATE_HOME',
              'XDG_CACHE_HOME',
              'TMPDIR',
            ].map((key) => [key, process.env[key]]),
          ),
          PATH: process.env['PATH'],
        },
      },
    );
    const exit = once(processF, 'close');
    try {
      const info = await Promise.race([
        once(processF.stdout, 'data').then(([b]) => JSON.parse(String(b))),
        exit.then(() => {
          throw Error('foreign namespace setup failed');
        }),
      ]);
      const [network, pidNamespace, localPid, localUid] = info;
      expect(network).not.toBe(readlinkSync('/proc/self/ns/net'));
      expect(pidNamespace).not.toBe(readlinkSync('/proc/self/ns/pid'));
      expect([localPid, localUid]).toEqual([1, 0]);
      const inode = lstatSync(foreign, { bigint: true }).ino;
      inject = (program) =>
        program
          .replace(
            'pin = os.open',
            `os.rename(path,${JSON.stringify(original)})\nos.rename(${JSON.stringify(foreign)},path)\npin = os.open`,
          )
          .replace(
            'with peer:',
            `with peer:
        import json, struct
        translated = struct.unpack('=iII', peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        listener_identity = struct.unpack('=iII', probe.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        with open(${JSON.stringify(kernel)}, 'w') as record:
            json.dump(dict(same_address=peer_address == address, host_pid=translated[0] > 1,
                           foreign_pid=translated[0] != os.getpid(), same_uid=translated[1] == os.geteuid(),
                           same_gid=translated[2] == os.getegid(), both_directions=listener_identity == translated),record)`,
          );
      const outcome = await startLocalRuntime({ profile, provider: null }).then(
        async (host) => {
          const published = lstatSync(paths.endpoint, { bigint: true }).ino === inode;
          const stop = await host.stop();
          await host.closed;
          return { published, stop: stop.outcome, preserved: existsSync(paths.endpoint) };
        },
        (e: Error) => e.message,
      );
      const [copied, ctime] = JSON.parse(readFileSync(evidence, 'utf8'));
      expect(copied).toBe(true);
      expect(JSON.parse(readFileSync(kernel, 'utf8'))).toEqual({
        same_address: true,
        host_pid: true,
        foreign_pid: true,
        same_uid: true,
        same_gid: true,
        both_directions: true,
      });
      expect(outcome).toBe('endpoint_changed');
      expect(existsSync(paths.descriptor)).toBe(false);
      const preserved = lstatSync(paths.endpoint, { bigint: true });
      expect([preserved.ino, preserved.ctimeNs, preserved.mode & 0o777n]).toEqual([
        inode,
        BigInt(ctime),
        0o600n,
      ]);
      const dead = connect(original);
      try {
        await expect(once(dead, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      } finally {
        dead.destroy();
      }
      const stillServing = connect(paths.endpoint);
      try {
        expect(String((await once(stillServing, 'data'))[0])).toBe('foreign listener');
      } finally {
        stillServing.destroy();
      }
      const reopened = openOceanProfile(profile);
      await reopened.ready;
      reopened.close();
      expect((await exit)[0]).toBe(0);
    } finally {
      inject = undefined;
      processF.kill('SIGKILL');
      try {
        await exit;
      } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  15000,
);
