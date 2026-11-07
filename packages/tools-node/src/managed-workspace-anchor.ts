import { statfs } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { desktopBtrfsProgram } from './desktop-btrfs-anchor.js';
export function managedBudget(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (Date.now() >= deadline) throw Error('managed inventory deadline');
}
/** Same fixed fd-only ABI as Desktop; asynchronous and owned until the exact helper exits. */
export async function managedWorkspaceAnchor(
  fd: number,
  signal: AbortSignal,
  deadline: number,
): Promise<string | null> {
  managedBudget(signal, deadline);
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  if (Number((await statfs('/proc/self/fd/' + fd)).type) !== 0x9123683e) {
    managedBudget(signal, deadline);
    return null;
  }
  managedBudget(signal, deadline);
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', desktopBtrfsProgram], {
      cwd: '/',
      env: {},
      stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    let stdout = '',
      stderr = '',
      failure: Error | undefined;
    const abort = () => {
      failure ??= Error('managed anchor interrupted');
      child.kill('SIGKILL');
    };
    const timer = setTimeout(abort, Math.min(2000, Math.max(1, deadline - Date.now())));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout!.on('data', (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > 1024) abort();
    });
    child.stderr!.on('data', (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 1024) abort();
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code, killed) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure || code !== 0 || killed || stderr || !stdout)
        reject(failure ?? Error('managed anchor unavailable'));
      else resolve(stdout);
    });
  });
  managedBudget(signal, deadline);
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('managed anchor unavailable');
  const a = v as Record<string, unknown>;
  if (
    Object.keys(a).sort().join() !== 'filesystem,handle,subvolume,subvolumeId,type' ||
    !['filesystem', 'subvolume', 'subvolumeId', 'handle'].every(
      (key) => typeof a[key] === 'string',
    ) ||
    !Number.isInteger(a['type'])
  )
    throw Error('managed anchor unavailable');
  return [
    'linux-btrfs-v1',
    a['filesystem'],
    a['subvolume'],
    a['subvolumeId'],
    a['type'],
    a['handle'],
  ].join(':');
}
