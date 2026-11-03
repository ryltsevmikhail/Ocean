import type * as ChildProcessModule from 'node:child_process';
import * as fs from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
import { holdBackupObservation } from './backup-observation.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
  vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('runs the actual terminal helper with only sterile env and the original read-only FD', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-terminal-'));
  roots.push(root);
  const path = join(root, 'copy'),
    unrelated = join(root, 'unrelated'),
    preload = join(root, 'preload.cjs');
  fs.writeFileSync(path, 'original exact bytes', { mode: 0o600 });
  fs.writeFileSync(unrelated, 'not inherited', { mode: 0o600 });
  fs.writeFileSync(
    preload,
    `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'preloaded'))}, 'bad')`,
  );
  vi.stubEnv('NODE_OPTIONS', '--require=' + preload);
  vi.stubEnv('OCEAN_TEST_TERMINAL_CANARY', 'must-not-inherit');
  const extra = fs.openSync(unrelated, 'r'),
    other = fs.fstatSync(extra),
    observation = holdBackupObservation(path);
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
  let launches = 0;
  try {
    vi.mocked(spawnSync).mockImplementation(((
      command: string,
      args: readonly string[],
      options: SpawnSyncOptions,
    ) => {
      launches++;
      expect(command).toBe(process.execPath);
      expect(args.slice(0, 2)).toEqual(['--input-type=commonjs', '-e']);
      expect(options.timeout).toBe(30000);
      expect(options.killSignal).toBe('SIGKILL');
      expect(options.maxBuffer).toBe(1024);
      const allowed = [
        'HOME',
        'XDG_RUNTIME_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'TMPDIR',
      ];
      expect(options.env).toEqual(
        Object.fromEntries(
          allowed
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      );
      expect(Array.isArray(options.stdio)).toBe(true);
      const descriptors = options.stdio as ['pipe', 'pipe', 'pipe', number];
      expect(descriptors.slice(0, 3)).toEqual(['pipe', 'pipe', 'pipe']);
      expect(descriptors.length).toBe(4);
      expect(fs.realpathSync('/proc/self/fd/' + descriptors[3])).toBe(path);
      expect(Object.keys(JSON.parse(String(options.input))).sort()).toEqual([
        'bytes',
        'hash',
        'state',
      ]);
      const assertions = `
const assert = require('node:assert/strict'), io = require('node:fs');
assert.deepEqual(Object.keys(process.env).sort(), ${JSON.stringify(Object.keys(options.env!).sort())});
assert.equal(io.fstatSync(3).ino, ${fs.statSync(path).ino});
assert.equal(parseInt(/^flags:\\s+([0-7]+)$/m.exec(io.readFileSync('/proc/self/fdinfo/3','utf8'))[1],8)&3,0);
for(let fd=4;fd<128;fd++){let s;try{s=io.fstatSync(fd)}catch{continue}assert.ok(s.ino!==${other.ino}||s.dev!==${other.dev});}
`;
      return actual.spawnSync(command, [...args.slice(0, 2), assertions + args[2]], options);
    }) as typeof spawnSync);
    observation.verifyTerminal();
    expect(launches).toBe(1);
    expect(fs.existsSync(join(root, 'preloaded'))).toBe(false);
    expect(fs.readFileSync(path, 'utf8')).toBe('original exact bytes');
  } finally {
    observation.close();
    fs.closeSync(extra);
  }
});
