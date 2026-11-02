import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOceanProfile } from '../ocean/profile.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function probe(program: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'ocean-review-process-'));
  const profile = join(root, 'profile'),
    run = join(root, 'run');
  mkdirSync(run, { mode: 0o700 });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  runtime.close();
  const imports = `import { chmodSync, mkdirSync, lstatSync } from 'node:fs';
    import { startLocalRuntime } from './apps/cli/dist/local-runtime/host.js';
    import { openOceanProfile } from './apps/cli/dist/ocean/profile.js';
    import { connectLocalRuntime, localRuntimePaths } from './packages/tools-node/dist/index.js';
    const profile = process.argv[1], paths = localRuntimePaths(profile);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', imports + program, profile], {
    env: { PATH: process.env['PATH'], XDG_RUNTIME_DIR: run },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '',
    output = '';
  child.stderr.on('data', (b: Buffer) => {
    errors += b.toString();
  });
  const exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
  cleanups.push(async () => {
    child.kill('SIGKILL');
    await exit;
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('probe timeout: ' + errors)), 5000);
    child.stdout.on('data', (b: Buffer) => {
      output += b.toString();
      if (!output.includes('\n')) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.split('\n')[0]!));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    void exit.then(() => {
      clearTimeout(timeout);
      if (!output.includes('\n')) reject(Error('probe exited: ' + errors));
    });
  });
}
it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)(
  'keeps the SQLite owner with a live listener when descriptor unlink actually fails',
  async () => {
    const result = await probe(`
    const host = await startLocalRuntime({ profile, provider: null });
    const observer = await connectLocalRuntime({ profile });
    chmodSync(paths.directory, 0o500);
    const stopped = await host.stop();
    chmodSync(paths.directory, 0o700);
    let ownerBusy = false;
    try { const other = openOceanProfile(profile); await other.ready; other.close(); }
    catch (error) { ownerBusy = error.code === 'owner_busy'; }
    const status = await observer.status();
    console.log(JSON.stringify({ stopped, status, ownerBusy, socket: lstatSync(paths.endpoint).isSocket() }));
    observer.close(); await host.closed;`);
    expect(result).toMatchObject({
      stopped: { outcome: 'uncertain' },
      status: { state: 'stop_incomplete' },
      socket: true,
      ownerBusy: true,
    });
  },
  10000,
);
it.runIf(process.platform === 'linux')(
  'publishes a usable exact-0600 descriptor under restrictive umask with pre-existing private directories',
  async () => {
    const result = await probe(`
    mkdirSync(paths.directory, { mode: 0o700 });
    process.umask(0o277);
    const host = await startLocalRuntime({ profile, provider: null });
    const mode = lstatSync(paths.descriptor).mode & 0o777;
    let usable = false;
    try { const client = await connectLocalRuntime({ profile }); usable = (await client.status()).state === 'ready'; client.close(); }
    catch {}
    const stopped = await host.stop(); await host.closed;
    console.log(JSON.stringify({ mode, usable, stopped }));`);
    expect(result).toMatchObject({ mode: 0o600, usable: true, stopped: { outcome: 'complete' } });
  },
  10000,
);
