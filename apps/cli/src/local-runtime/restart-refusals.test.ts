import type * as Net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  readlinkSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectLocalRuntime, localRuntimePaths } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { recoverEndpoint } from './endpoint.js';
import { EndpointLayout, mount, profileKey } from './endpoint-files.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
let beforeProbeError: (() => void) | undefined;
vi.mock('node:net', async (original) => {
  const net = await original<typeof Net>();
  return {
    ...net,
    connect: (...args: Parameters<typeof connect>) => {
      const socket = net.connect(...args);
      if (beforeProbeError) socket.once('error', beforeProbeError);
      return socket;
    },
  };
});
async function fixture(kill = true) {
  const root = mkdtempSync(join(tmpdir(), 'ocean-refuse-')),
    profile = join(root, 'profile'),
    run = join(root, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const r = openOceanProfile(profile, true);
  await r.ready;
  r.close();
  const paths = localRuntimePaths(profile);
  if (kill) {
    const p = spawn(
      process.execPath,
      ['apps/cli/dist/main.js', 'runtime', 'start', '--profile', profile, '--json'],
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
          XDG_RUNTIME_DIR: run,
        },
      },
    );
    const exit = once(p, 'close');
    try {
      expect(String((await once(p.stdout, 'data'))[0])).toContain('ready');
    } finally {
      p.kill('SIGKILL');
      await exit;
    }
  }
  return { profile, run, root, paths };
}
function snapshot(directory: string): unknown {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const st = lstatSync(path, { bigint: true });
      return [
        name,
        String(st.ino),
        String(st.mode),
        String(st.uid),
        String(st.mtimeNs),
        String(st.ctimeNs),
        st.isFile()
          ? createHash('sha256').update(readFileSync(path)).digest('hex')
          : st.isSymbolicLink()
            ? readlinkSync(path)
            : null,
      ];
    });
}
it.each([
  'forged contents',
  'wrong profile',
  'copied descriptor',
  'descriptor mode',
  'socket mode',
  'symlink',
  'FIFO',
  'directory replacement',
  'missing descriptor',
  'extra staging file',
  'foreign listener',
  'legacy',
])('preserves all endpoint evidence on %s refusal', async (kind) => {
  const { root, profile, paths } = await fixture();
  const before = join(root, 'before');
  switch (kind) {
    case 'forged contents':
      writeFileSync(paths.descriptor, 'forged-private-canary');
      break;
    case 'wrong profile': {
      const value = JSON.parse(readFileSync(paths.descriptor, 'utf8'));
      writeFileSync(paths.descriptor, JSON.stringify({ ...value, profileId: 'foreign' }));
      break;
    }
    case 'copied descriptor':
      renameSync(paths.descriptor, before);
      writeFileSync(paths.descriptor, readFileSync(before), { mode: 0o600 });
      break;
    case 'descriptor mode':
      chmodSync(paths.descriptor, 0o640);
      break;
    case 'socket mode':
      chmodSync(paths.endpoint, 0o660);
      break;
    case 'symlink':
      unlinkSync(paths.descriptor);
      symlinkSync(join(root, 'missing'), paths.descriptor);
      break;
    case 'FIFO':
      unlinkSync(paths.descriptor);
      execFileSync('mkfifo', [paths.descriptor]);
      break;
    case 'directory replacement':
      renameSync(paths.directory, before);
      mkdirSync(paths.directory, { mode: 0o700 });
      for (const name of readdirSync(before))
        renameSync(join(before, name), join(paths.directory, name));
      break;
    case 'missing descriptor':
      unlinkSync(paths.descriptor);
      break;
    case 'extra staging file':
      writeFileSync(join(paths.directory, '.connection-partial'), 'evidence', { mode: 0o600 });
      break;
    case 'foreign listener': {
      unlinkSync(paths.endpoint);
      const server = createServer((socket) => socket.end('foreign'));
      server.listen(paths.endpoint);
      await once(server, 'listening');
      chmodSync(paths.endpoint, 0o600);
      cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      break;
    }
    case 'legacy': {
      const db = new DatabaseSync(join(profile, 'runtime.sqlite'));
      try {
        db.exec('DROP TABLE local_endpoint_v1');
      } finally {
        db.close();
      }
      break;
    }
  }
  const entries = snapshot(paths.directory);
  await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
    /^(endpoint_exists|endpoint_changed|insecure_permissions)$/,
  );
  expect(snapshot(paths.directory)).toEqual(entries);
  if (kind === 'foreign listener') {
    const s = connect(paths.endpoint);
    expect(String((await once(s, 'data'))[0])).toBe('foreign');
    s.destroy();
  }
});
it('revalidates bindings after the liveness probe without unlinking a substituted descriptor', async () => {
  const { paths, root, profile } = await fixture();
  const moved = join(root, 'before'),
    socket = lstatSync(paths.endpoint).ino;
  beforeProbeError = () => {
    renameSync(paths.descriptor, moved);
    writeFileSync(paths.descriptor, 'race-canary', { mode: 0o600 });
  };
  try {
    await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
      'endpoint_changed',
    );
  } finally {
    beforeProbeError = undefined;
  }
  expect(lstatSync(paths.endpoint).ino).toBe(socket);
  expect(readFileSync(paths.descriptor, 'utf8')).toBe('race-canary');
});
it('refuses an attested still-listening inode independently of its SQLite proof', async () => {
  const { profile, paths } = await fixture(false);
  const host = await startLocalRuntime({ profile, provider: null });
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  try {
    const digest = String(db.prepare('SELECT digest FROM local_endpoint_v1').get()?.['digest']);
    await expect(
      recoverEndpoint(
        paths,
        {
          current: () => digest,
          retire: () => {
            throw Error('retired live');
          },
          publish: () => {},
        },
        profileKey(paths),
      ),
    ).rejects.toThrow('endpoint_exists');
    const c = await connectLocalRuntime({ profile });
    try {
      expect((await c.status()).instanceId).toBe(host.identity.instanceId);
    } finally {
      c.close();
    }
  } finally {
    db.close();
    await host.stop();
    await host.closed;
  }
});

it('preserves an in-place descriptor substitution between publication and activation', async () => {
  const { paths, profile } = await fixture(false);
  const original = EndpointLayout.prototype.proof;
  const hook = vi.spyOn(EndpointLayout.prototype, 'proof').mockImplementationOnce(function (
    this: EndpointLayout,
    ...args
  ) {
    const digest = original.apply(this, args);
    writeFileSync(paths.descriptor, 'foreign-publication', { mode: 0o600 });
    return digest;
  });
  try {
    await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
      'endpoint_changed',
    );
  } finally {
    hook.mockRestore();
  }
  expect(readFileSync(paths.descriptor, 'utf8')).toBe('foreign-publication');
});

it.each([
  ['stream-challenge', ''],
  ['direct-peer-v1', 'ocean-endpoint-direct-peer-v1\0'],
] as const)('refuses the matching legacy %s digest', async (_version, tag) => {
  const { paths, profile } = await fixture();
  // Reconstruct each retired publication format from the exact synthetic files.
  const layout = new EndpointLayout(paths, profileKey(paths));
  const legacy = createHash('sha256').update(tag).update(layout.identity);
  try {
    for (const name of ['runtime.sock', 'connection.json']) {
      const fd = layout.pin(name);
      try {
        const s = fstatSync(fd, { bigint: true });
        const key = [mount(fd), s.dev, s.ino, s.birthtimeNs, s.mode, s.uid, s.gid].join(':');
        legacy.update(JSON.stringify([key, String(s.ctimeNs), String(s.mtimeNs), String(s.size)]));
        if (name === 'connection.json') legacy.update(readFileSync(paths.descriptor));
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    layout.close();
  }
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'));
  try {
    db.prepare('UPDATE local_endpoint_v1 SET digest=?').run(legacy.digest('hex'));
  } finally {
    db.close();
  }
  const entries = snapshot(paths.directory);
  const start = startLocalRuntime({ profile, provider: null }).then(async (host) => {
    await host.stop();
    await host.closed;
    return 'accepted old binding';
  });
  await expect(start).rejects.toThrow('endpoint_exists');
  expect(snapshot(paths.directory)).toEqual(entries);
});
