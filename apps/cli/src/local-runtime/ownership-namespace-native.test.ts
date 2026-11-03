import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';

const native = process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1';
const initialize =
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  }) + '\n';
function launch(args: string[], env: NodeJS.ProcessEnv, namespace: boolean) {
  const child = spawn(
    namespace ? '/usr/bin/unshare' : process.execPath,
    namespace
      ? [
          '--map-root-user',
          '--pid',
          '--fork',
          '--mount-proc',
          '/usr/bin/python3',
          '-c',
          'import subprocess,sys;open("/proc/sys/kernel/ns_last_pid","w").write("3400000");sys.exit(subprocess.call(sys.argv[1:]))',
          process.execPath,
          ...args,
        ]
      : args,
    { env, stdio: 'pipe' },
  );
  let out = '',
    err = '';
  child.stdout.on('data', (b: Buffer) => {
    out += b.toString();
  });
  child.stderr.on('data', (b: Buffer) => {
    err += b.toString();
  });
  const exit = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  return { child, exit, out: () => out, err: () => err };
}
it.runIf(native).each([true, false])(
  'refuses cross-namespace recovery, maintenance and migration with ACP first=%s',
  async (namespace) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-owner-ns-'));
    const profile = join(root, 'profile'),
      run = join(root, 'run');
    mkdirSync(run, { mode: 0o700 });
    const runtime = openOceanProfile(profile, true);
    await runtime.ready;
    runtime.close();
    const path = join(profile, 'runtime.sqlite');
    const env = {
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
      HOME: root,
      XDG_RUNTIME_DIR: run,
    };
    const owner = namespace
      ? launch([resolve('apps/cli/dist/main.js'), 'acp'], { ...env, RUNNE_DB: path }, true)
      : launch(
          [resolve('apps/cli/dist/main.js'), 'runtime', 'start', '--profile', profile, '--json'],
          env,
          false,
        );
    const db = new DatabaseSync(path);
    try {
      if (namespace) owner.child.stdin.write(initialize);
      await vi.waitFor(
        () => expect(owner.out()).toContain(namespace ? '"protocolVersion":1' : '"state":"ready"'),
        { timeout: 5000 },
      );
      const before = db.prepare('SELECT * FROM runtime_owner_v1').get();
      db.exec(
        "CREATE TABLE owner_audit(value TEXT); CREATE TRIGGER ownership_before_schema AFTER UPDATE ON meta BEGIN INSERT INTO owner_audit VALUES('schema touched'); END",
      );
      // A synthetic started claim must not be reconciled by the competing owner.
      db.exec("INSERT INTO tool_invocations_v1 VALUES('namespace-effect','fixture','started')");
      const contender = namespace
        ? launch(
            [resolve('apps/cli/dist/main.js'), 'runtime', 'start', '--profile', profile, '--json'],
            env,
            false,
          )
        : launch([resolve('apps/cli/dist/main.js'), 'acp'], { ...env, RUNNE_DB: path }, true);
      contender.child.stdin.end();
      if (namespace)
        await vi.waitFor(() => expect(contender.out()).toContain('\n'), { timeout: 5000 });
      // Stop an incorrectly admitted baseline owner so a RED run leaves no listener behind.
      if (contender.out().includes('"state":"ready"')) {
        const stop = launch(
          [resolve('apps/cli/dist/main.js'), 'runtime', 'stop', '--profile', profile, '--json'],
          env,
          !namespace,
        );
        await stop.exit;
      }
      expect(await contender.exit).toBe(3);
      expect(contender.out() + contender.err()).toContain('owner_busy');
      expect(db.prepare('SELECT * FROM runtime_owner_v1').get()).toEqual(before);
      expect(db.prepare('SELECT * FROM owner_audit').all()).toEqual([]);
      expect(
        db.prepare("SELECT outcome FROM tool_invocations_v1 WHERE id='namespace-effect'").get()?.[
          'outcome'
        ],
      ).toBe('started');
      const inspect = launch(
        [
          '--input-type=module',
          '-e',
          `
        import {inspectDatabase,snapshotDatabase} from './packages/store-sqlite/dist/index.js';
        console.log(inspectDatabase(${JSON.stringify(path)}).status);
        try {await snapshotDatabase(${JSON.stringify(path)},${JSON.stringify(join(root, 'copy.sqlite'))});console.log('copied');}
        catch(e){console.log(e.message);}
      `,
        ],
        env,
        !namespace,
      );
      expect(await inspect.exit).toBe(0);
      expect(inspect.out()).toBe('owner_busy\nowner_busy\n');
      db.exec(
        "DROP TABLE ocean_owner_decisions; UPDATE meta SET value='10' WHERE key='schema_version'",
      );
      const migration = launch(
        [
          '--input-type=module',
          '-e',
          `
        import {openSqliteStore} from './packages/store-sqlite/dist/index.js';
        try {openSqliteStore({path:${JSON.stringify(path)}}).close();console.log('migrated');}
        catch(e){console.log(e.message);}
      `,
        ],
        env,
        !namespace,
      );
      expect(await migration.exit).toBe(0);
      expect(migration.out()).toContain('Schema migration refused');
      expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
        '10',
      );
      if (namespace) {
        owner.child.stdin.write(initialize.replace('"id":1', '"id":2'));
        await vi.waitFor(() => expect(owner.out()).toContain('"id":2'), { timeout: 5000 });
      }
    } finally {
      if (namespace) owner.child.stdin.end();
      else owner.child.kill('SIGTERM');
      await owner.exit;
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
