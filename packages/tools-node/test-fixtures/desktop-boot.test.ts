import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { vi } from 'vitest';
export async function simulateDesktopFilesystem(type: number): Promise<void> {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.statfsSync).mockImplementation((path, options) => {
    const stat = actual.statfsSync(path, options);
    stat.type = typeof stat.type === 'bigint' ? BigInt(type) : type;
    return stat;
  });
}
export function desktopHelperResult(stdout: string): cp.SpawnSyncReturns<string> {
  return { pid: 0, output: [null, stdout, ''], status: 0, signal: null, stdout, stderr: '' };
}
/** Synthetic host observations only; real files, SQLite and all publication paths stay in use. */
export async function desktopBootSimulation() {
  const actual = await vi.importActual<typeof fs>('node:fs');
  const child = await vi.importActual<typeof cp>('node:child_process');
  let boot = 0;
  const affected = (path: unknown) => {
    try {
      const resolved = actual.realpathSync(
        typeof path === 'number' ? '/proc/self/fd/' + String(path) : String(path),
      );
      return /\/desktop-[a-f0-9-]{36}(?:\/|$)/.test(resolved);
    } catch {
      return false;
    }
  };
  await simulateDesktopFilesystem(0x9123683e);
  vi.mocked(cp.spawnSync).mockImplementation((program, args, options) => {
    if (program !== '/usr/bin/python3' || args?.[0] !== '-I')
      return child.spawnSync(program, args, options);
    const fd = Array.isArray(options?.stdio) ? options.stdio[3] : undefined;
    if (typeof fd !== 'number' || options?.encoding !== 'utf8')
      throw Error('invalid_desktop_helper_fixture');
    const stat = actual.fstatSync(fd, { bigint: true });
    return desktopHelperResult(
      JSON.stringify({
        filesystem: '1'.repeat(32),
        subvolume: '2'.repeat(32),
        subvolumeId: '257',
        type: 77,
        handle: stat.ino.toString(16).padStart(40, '0'),
      }),
    );
  });
  for (const key of ['fstatSync', 'lstatSync', 'statSync'] as const)
    vi.mocked(fs[key]).mockImplementation(((...args: unknown[]) => {
      const stat = Reflect.apply(actual[key], actual, args) as fs.BigIntStats | undefined;
      if (stat && affected(args[0]))
        stat.dev =
          typeof stat.dev === 'bigint'
            ? stat.dev + BigInt(boot)
            : ((Number(stat.dev) + boot) as unknown as bigint);
      return stat;
    }) as never);
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const result = actual.readFileSync(...args);
    return boot &&
      String(args[0]).startsWith('/proc/self/fdinfo/') &&
      affected(Number(String(args[0]).split('/').at(-1))) &&
      typeof result === 'string'
      ? result.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t' + String(999000 + boot))
      : result;
  }) as typeof fs.readFileSync);
  return {
    reboot: () => {
      boot++;
    },
  };
}
