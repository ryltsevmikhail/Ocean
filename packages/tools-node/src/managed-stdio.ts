import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, readFile, readdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sandboxArgv, sandboxRoot, SANDBOX_NODE } from './sandbox-layout.js';
import { sandboxLauncher } from './sandbox-launcher.js';
import { control, controlEnv, observedGroup, retiredGroup } from './sandbox-cgroup.js';

const owned = new Set<string>();
const overlap = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export interface ManagedStdioRequest {
  readonly profileRoot: string;
  readonly workspace: string;
  readonly connectionId: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly packageJsonSha256?: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
}
async function pin(artifact: string, digest: string, limit: number) {
  const f = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const st = await f.stat();
    if (!st.isFile() || st.size > limit || st.nlink !== 1) throw Error('invalid artifact');
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await f.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('short artifact');
      offset += bytesRead;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw Error('artifact changed');
    return createHash('sha256')
      .update(JSON.stringify([String(st.mode), String(st.size)]))
      .update(bytes)
      .digest('hex');
  } finally {
    await f.close();
  }
}
/** One isolated, pinned JS bundle. The parent is the authority holder; only this server enters the unit. */
export async function prepareManagedStdio(r: ManagedStdioRequest) {
  r.signal.throwIfAborted();
  const node = await realpath(process.execPath);
  const profile = await realpath(r.profileRoot);
  const root = await realpath(r.workspace);
  if (
    profile !== r.profileRoot ||
    root !== r.workspace ||
    root === '/' ||
    overlap(root, profile) ||
    [homedir(), userInfo().homedir].some((home) => home === root || home.startsWith(root + '/')) ||
    /^\/(etc|usr|run|dev|proc|sys|boot|root|var)(\/|$)/.test(root) ||
    (await realpath(r.artifact)) !== r.artifact ||
    overlap(root, r.artifact) ||
    overlap(r.artifact, profile) ||
    (r.args.length && !(r.args.length === 1 && r.args[0] === '/workspace'))
  )
    throw Error('invalid stdio enrollment');
  await sandboxRoot(root, [], undefined, true);
  const expected: Record<string, string> = {
    [r.artifact]: await pin(r.artifact, r.sha256, 32 * 1024 * 1024),
  };
  const metadata = join(dirname(r.artifact), 'package.json');
  if (r.packageJsonSha256) expected[metadata] = await pin(metadata, r.packageJsonSha256, 65536);
  const prefix = 'ocean-mcp-' + sha(JSON.stringify([profile, r.connectionId])).slice(0, 32) + '-';
  const unit = prefix + randomUUID() + '.service';
  const slice = (await control(['show', 'app.slice', '--property=ControlGroup', '--value'])).trim();
  if (!/^\/user\.slice\/user-\d+\.slice\/user@\d+\.service\/app\.slice$/.test(slice))
    throw Error('unsupported user slice');
  const groups = await readdir('/sys/fs/cgroup' + slice);
  const units = await control([
    'list-units',
    '--all',
    '--plain',
    '--no-legend',
    '--full',
    prefix + '*.service',
  ]);
  const old = [
    ...groups,
    ...units
      .trim()
      .split('\n')
      .map((s) => s.trim().split(/\s+/)[0] ?? ''),
  ].filter((s) => s.startsWith(prefix));
  if (old.some((name) => !owned.has(name))) throw Error('previous server retirement unconfirmed');

  const argv = sandboxArgv(root, '', [], node);
  const mask = argv.indexOf('/workspace/.git');
  argv.splice(mask - 2, 3); // A service workspace must contain no VCS administration.
  argv.splice(argv.lastIndexOf(SANDBOX_NODE), 4, SANDBOX_NODE, '/toolchain/server.mjs', ...r.args);
  argv.splice(
    argv.indexOf('--chdir'),
    0,
    '--ro-bind',
    r.artifact,
    '/toolchain/server.mjs',
    ...(r.packageJsonSha256 ? ['--ro-bind', metadata, '/toolchain/package.json'] : []),
    ...Object.entries({
      TMPDIR: '/tmp',
      XDG_CONFIG_HOME: '/home/worker/config',
      XDG_DATA_HOME: '/home/worker/data',
      XDG_STATE_HOME: '/home/worker/state',
      XDG_CACHE_HOME: '/home/worker/cache',
      XDG_RUNTIME_DIR: '/home/worker/run',
    }).flatMap(([key, value]) => ['--dir', value, '--setenv', key, value]),
  );
  const start = (await readFile('/proc/self/stat', 'utf8')).split(') ').at(-1)!.split(' ')[19];
  const path = slice + '/' + unit;
  const guardian = `
    const read=require('node:fs').readFileSync;
    function ownerAlive(){
      try {const f=read('/proc/${process.pid}/stat','utf8').split(') ').at(-1).split(' '); return f[0]!=='Z' && f[19]===${JSON.stringify(start)};}catch{return false;}
    }
    if(!ownerAlive() || !read('/proc/self/cgroup','utf8').split('\\n').includes(${JSON.stringify('0::' + path)}))process.exit(75);
    setInterval(()=>{if(!ownerAlive())process.exit(75);},100).unref();
  `;
  const launcher = guardian + (await sandboxLauncher(argv, expected));
  const args = [
    '--user',
    '--quiet',
    '--wait',
    '--pipe',
    '--collect',
    '--service-type=exec',
    '--slice=app.slice',
    '--unit=' + unit,
    '--property=KillMode=control-group',
    '--property=RuntimeDirectory=' + unit.slice(0, -8),
    '--property=RuntimeDirectoryMode=0700',
    '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=2s',
    '--property=RuntimeMaxSec=60s',
    '--property=MemoryMax=536870912',
    '--property=TasksMax=64',
    '--property=NoNewPrivileges=yes',
    '--property=ProtectControlGroups=yes',
    '--expand-environment=no',
    node,
    '--input-type=commonjs',
    '-e',
    launcher,
  ];
  r.signal.throwIfAborted();
  let attempted = false,
    observed = false;
  return {
    parameters: {
      command: '/usr/bin/systemd-run',
      args,
      env: { ...controlEnv },
      cwd: dirname(node),
      stderr: 'pipe' as const,
      maxBufferSize: 4 * 1024 * 1024,
    },
    start() {
      r.signal.throwIfAborted();
      attempted = true;
      owned.add(unit);
    },
    async observe() {
      for (let i = 0; i < 80; i++) {
        r.signal.throwIfAborted();
        if ((await observedGroup(unit).catch(() => null)) === path) {
          observed = true;
          return;
        }
        await delay(25);
      }
      throw Error('server unit not observed');
    },
    async cleanup(): Promise<'never_started' | 'unknown' | 'confirmed'> {
      if (!attempted) return 'never_started';
      // Unit names have a fresh nonce. Never stop by prefix or a reused process ID.
      await control(['stop', unit]).catch(() => {});
      const retired = observed && (await retiredGroup(path));
      owned.delete(unit);
      return retired ? 'confirmed' : 'unknown';
    },
  };
}
