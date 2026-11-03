import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

// Only the isolated foreground owner receives the synthetic provider and test key.
export async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-gui-'));
  const profile = join(root, 'profile'),
    run = join(root, 'run'),
    workspace = join(root, 'workspace');
  mkdirSync(run, { mode: 0o700 });
  mkdirSync(workspace);
  const cli = resolve('apps/cli/dist/main.js');
  const env = { PATH: process.env.PATH, XDG_RUNTIME_DIR: run };
  const args = ['--profile', profile, '--json'];
  function command(...words) {
    const out = execFileSync(process.execPath, [cli, ...words, ...args], { env, encoding: 'utf8' });
    return JSON.parse(out).data;
  }
  command('init', '--workspace', workspace);
  const owner = spawn(
    process.execPath,
    [
      '--import',
      resolve('apps/desktop/qa/provider.mjs'),
      '--import',
      resolve('apps/desktop/qa/drop-reply.mjs'),
      cli,
      'runtime',
      'start',
      ...args,
    ],
    {
      env: { ...env, DEEPSEEK_API_KEY: 'fixture-only', OCEAN_TEST_LOG: join(root, 'requests') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exit = new Promise((resolve) => owner.once('close', resolve));
  let log = '';
  owner.stdout.on('data', (b) => (log += b));
  owner.stderr.on('data', (b) => (log += b));
  async function close() {
    owner.kill('SIGKILL');
    await exit;
    rmSync(root, { recursive: true, force: true });
  }
  for (let i = 0; i < 200; i++) {
    if (log.includes('"ready"')) return { root, profile, env, command, close };
    if (owner.exitCode !== null) break;
    await setTimeout(50);
  }
  await close();
  throw Error('owner startup failed ' + log);
}
export function windowEnv(f) {
  const result = { ...f.env, OCEAN_DESKTOP_PROFILE: f.profile };
  for (const key of [
    'HOME',
    'DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'LANG',
    'XAUTHORITY',
    'XDG_SESSION_TYPE',
  ]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  if (process.env.WAYLAND_DISPLAY)
    result.WAYLAND_DISPLAY = resolve(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY);
  return result;
}
