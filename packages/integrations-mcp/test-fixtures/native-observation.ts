import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/' + process.getuid!() };
export const ctl = (...args: string[]) =>
  execFileSync('/usr/bin/systemctl', ['--user', ...args], { env, encoding: 'utf8' }).trim();
export const read = (p: string) => readFileSync(p, 'utf8').trim();
export const inspect = (cg: string) => {
  const root = '/sys/fs/cgroup' + cg;
  const pids = read(root + '/cgroup.procs')
    .split('\n')
    .map(Number);
  return {
    cg,
    pids: pids.map((pid) => ({
      pid,
      start: read('/proc/' + pid + '/stat')
        .split(') ')
        .at(-1)!
        .split(' ')[19],
    })),
    fields: Object.fromEntries(
      [
        'cgroup.events',
        'pids.current',
        'pids.peak',
        'memory.current',
        'memory.peak',
        'memory.max',
        'pids.max',
        'pids.events',
      ].map((k) => [k, read(root + '/' + k)]),
    ),
  };
};

export function serverObservation(path: string) {
  const obs = JSON.parse(read(path)) as {
    cwd: string;
    env: Record<string, string>;
    canary: boolean;
    socket: boolean;
  };
  assert.equal(obs.cwd, '/workspace');
  assert.equal(obs.env['PWD'], '/workspace');
  assert.equal(obs.env['HOME'], '/home/worker');
  assert.equal(obs.canary, false);
  assert.equal(obs.socket, false);
  assert.deepEqual(
    Object.keys(obs.env).sort(),
    [
      'HOME',
      'LANG',
      'PATH',
      'PWD',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
      'XDG_STATE_HOME',
    ].sort(),
  );
  return obs;
}
