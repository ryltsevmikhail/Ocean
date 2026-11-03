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
import { openSqliteStore } from '@runnets/store-sqlite';
import { verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { backupProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
  vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it.each(['launch', 'exit', 'signal', 'timeout', 'malformed', 'overflow', 'stderr'])(
  'retains both incomplete markers after actual terminal helper %s failure',
  async (kind) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-terminal-failure-'));
    roots.push(root);
    const profile = join(root, 'profile'),
      archive = join(root, 'archive');
    fs.mkdirSync(profile, { mode: 0o700 });
    const path = join(profile, 'runtime.sqlite');
    fs.closeSync(fs.openSync(path, 'wx', 0o600));
    openSqliteStore({ path }).close();
    fs.writeFileSync(join(profile, 'coding-projects.json'), '[]', { mode: 0o600 });
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
    let launches = 0;
    vi.mocked(spawnSync).mockImplementation(((
      command: string,
      args: readonly string[],
      options: SpawnSyncOptions,
    ) => {
      expect(args[2]).toContain('fstatSync(3');
      launches++;
      const code: Record<string, string> = {
        exit: 'process.exit(7)',
        signal: "process.kill(process.pid,'SIGKILL')",
        timeout: 'setInterval(()=>{},1000)',
        malformed: "process.stdout.write('verified\\nextra')",
        overflow: "process.stdout.write('x'.repeat(8192))",
        stderr: "process.stdout.write('verified\\n');process.stderr.write('unexpected')",
      };
      const result = actual.spawnSync(
        kind === 'launch' ? join(root, 'missing-node') : command,
        ['--input-type=commonjs', '-e', code[kind] ?? ''],
        { ...options, ...(kind === 'timeout' ? { timeout: 50 } : {}) },
      );
      if (kind === 'timeout') {
        expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
        expect(result.signal).toBe('SIGKILL');
      }
      if (kind === 'signal') expect(result.signal).toBe('SIGKILL');
      if (kind === 'launch') expect(result.error).toMatchObject({ code: 'ENOENT' });
      if (kind === 'overflow') expect(result.error).toMatchObject({ code: 'ENOBUFS' });
      return result;
    }) as typeof spawnSync);
    await expect(backupProfile(profile, archive)).rejects.toThrow('snapshot_mismatch');
    expect(launches).toBe(1);
    expect(fs.existsSync(join(archive, '.incomplete'))).toBe(true);
    expect(fs.existsSync(join(archive, 'assets', '.incomplete'))).toBe(true);
    expect(() => verifyProfileBackupEnvelope(archive)).toThrow();
  },
);
