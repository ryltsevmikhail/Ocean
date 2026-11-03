import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { expect } from 'vitest';
/** Dirty the mapping once before observation. A second store can preserve inode, size, mtime and ctime. */
export async function mapped(
  path: string,
  replacement: Buffer,
  run: (mutate: () => Promise<void>) => Promise<void>,
) {
  const script = `import sys,mmap
with open(sys.argv[1],'r+b') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE) as p:
 p[0]=p[0]
 print('ready',flush=True)
 if sys.stdin.buffer.read(1)==b'!':
  p[:]=bytes.fromhex(sys.argv[2])
  print('changed',flush=True)`;
  const child = spawn(
    '/usr/bin/python3',
    ['-I', '-S', '-c', script, path, replacement.toString('hex')],
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
        HOME: dirname(path),
      },
    },
  );
  const closed = once(child, 'close');
  const identity = () => {
    const { ino, size, mtimeNs, ctimeNs } = fs.statSync(path, { bigint: true });
    return [ino, size, mtimeNs, ctimeNs];
  };
  try {
    expect(String((await Promise.race([once(child.stdout, 'data'), closed]))[0]).trim()).toBe(
      'ready',
    );
    const before = identity();
    await run(async () => {
      const output = once(child.stdout, 'data');
      child.stdin.write('!');
      expect(String((await Promise.race([output, closed]))[0]).trim()).toBe('changed');
      expect(identity()).toEqual(before);
      expect(fs.readFileSync(path)).toEqual(replacement);
    });
  } finally {
    child.stdin.end();
    await closed;
  }
}
