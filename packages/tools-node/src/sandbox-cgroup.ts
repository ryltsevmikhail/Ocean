import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
const execute = promisify(execFile);
export const controlEnv = {
  PATH: '/usr/bin:/bin',
  XDG_RUNTIME_DIR: '/run/user/' + process.getuid?.(),
};
export async function control(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return (
    await execute('/usr/bin/systemctl', ['--user', ...args], {
      env: controlEnv,
      ...(signal ? { signal } : {}),
      timeout: 5000,
      maxBuffer: 65536,
    })
  ).stdout;
}
export function populated(events: string, expected: 0 | 1) {
  const fields = events.split('\n').filter((line) => /^populated\b/.test(line));
  return fields.length === 1 && fields[0] === 'populated ' + expected;
}
export async function observedGroup(unit: string, signal?: AbortSignal) {
  const path = (await control(['show', unit, '--property=ControlGroup', '--value'], signal)).trim();
  if (
    !path.startsWith('/user.slice/') ||
    basename(path) !== unit ||
    !path
      .slice(1)
      .split('/')
      .every((part) => /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]*$/.test(part))
  )
    throw Error('invalid cgroup');
  const events = await readFile('/sys/fs/cgroup' + path + '/cgroup.events', {
    encoding: 'utf8',
    signal,
  });
  if (!populated(events, 1)) throw Error('empty cgroup');
  return path;
}
export async function retiredGroup(path: string) {
  try {
    return populated(await readFile('/sys/fs/cgroup' + path + '/cgroup.events', 'utf8'), 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const siblings = await readdir('/sys/fs/cgroup' + dirname(path)).catch(() => null);
      return siblings !== null && !siblings.includes(basename(path));
    }
    return false;
  }
}
