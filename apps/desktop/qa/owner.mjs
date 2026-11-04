import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

// Only the isolated foreground owner receives the synthetic provider and test key.
export async function fixture(options = {}) {
  const root = mkdtempSync(join(options.root ?? tmpdir(), 'ocean-gui-'));
  const profile = join(root, 'profile'),
    workspace = join(root, 'workspace');
  const env = { PATH: process.env.PATH };
  for (const [key, folder] of Object.entries({
    HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'run',
    TMPDIR: 'tmp',
  })) {
    env[key] = join(root, folder);
    mkdirSync(env[key], { mode: 0o700 });
  }
  mkdirSync(workspace, { mode: 0o700 });
  const cli = resolve(options.cli ?? process.env.OCEAN_QA_CLI ?? 'apps/cli/dist/main.js');
  const args = ['--profile', profile, '--json'];
  function command(...words) {
    let out,
      code = 0;
    try {
      out = execFileSync(process.execPath, [cli, ...words, ...args], { env, encoding: 'utf8' });
    } catch (error) {
      code = error.status;
      out = error.stdout;
      appendFileSync(
        join(root, 'commands.jsonl'),
        JSON.stringify({ cli, words: [...words, ...args], code, output: out }) + '\n',
      );
      throw error;
    }
    appendFileSync(
      join(root, 'commands.jsonl'),
      JSON.stringify({ cli, words: [...words, ...args], code, output: out }) + '\n',
    );
    return JSON.parse(out).data;
  }
  command('init', '--workspace', workspace);
  let owner,
    identity,
    exit,
    log = '';
  async function start() {
    log = '';
    owner = spawn(
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
        env: {
          ...env,
          DEEPSEEK_API_KEY: 'fixture-only',
          OCEAN_TEST_LOG: join(root, 'requests'),
          ...(options.modelLog ? { OCEAN_TEST_MODEL_LOG: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stat = readFileSync('/proc/' + owner.pid + '/stat', 'utf8');
    identity = { pid: owner.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    exit = new Promise((resolve) =>
      owner.once('close', (code, signal) => resolve({ code, signal })),
    );
    owner.stdout.on('data', (b) => (log += b));
    owner.stderr.on('data', (b) => (log += b));
    for (let i = 0; i < 200; i++) {
      if (log.includes('"ready"')) return;
      if (owner.exitCode !== null) break;
      await setTimeout(50);
    }
    const failure = Error('owner startup failed ' + log);
    try {
      await stop();
    } catch (error) {
      failure.cause = error;
      await retire(error);
    }
    writeFileSync(join(root, 'startup-error.log'), String(failure), { mode: 0o600 });
    throw failure;
  }
  async function stop() {
    if (owner.exitCode === null) command('runtime', 'stop');
    await exit;
    writeFileSync(join(root, 'owner.log'), log, { mode: 0o600 });
    writeFileSync(join(root, 'owner-' + owner.pid + '.log'), log, { mode: 0o600 });
  }
  async function retire(error) {
    let sameOwner = false;
    try {
      const stat = readFileSync('/proc/' + identity.pid + '/stat', 'utf8');
      sameOwner = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === identity.start;
    } catch (readError) {
      if (readError.code !== 'ENOENT') throw readError;
    }
    if (sameOwner) owner.kill('SIGKILL');
    const outcome = await exit;
    // Retirement of this process is not confirmation of an Ocean effect's cancellation.
    // Keep startup/stop diagnostics and all uncertain fixture state for inspection.
    writeFileSync(join(root, 'owner.log'), log, { mode: 0o600 });
    writeFileSync(join(root, 'owner-' + owner.pid + '.log'), log, { mode: 0o600 });
    writeFileSync(join(root, 'cleanup-stop-error.log'), String(error), { mode: 0o600 });
    writeFileSync(
      join(root, 'cleanup-owner-exit.json'),
      JSON.stringify(
        {
          ...identity,
          signalRequested: sameOwner ? 'SIGKILL' : null,
          outcome,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  async function close() {
    try {
      await stop();
    } catch (error) {
      await retire(error);
    }
    if (!(options.preserve ?? process.env.OCEAN_QA_PRESERVE === '1'))
      rmSync(root, { recursive: true, force: true });
  }
  await start();
  return {
    root,
    profile,
    env,
    cli,
    get owner() {
      return owner;
    },
    command,
    close,
    stop,
    start,
  };
}
export function windowEnv(f) {
  const result = { ...f.env, OCEAN_DESKTOP_PROFILE: f.profile };
  for (const key of ['DISPLAY', 'LANG', 'XAUTHORITY', 'XDG_SESSION_TYPE']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  if (process.env.WAYLAND_DISPLAY)
    result.WAYLAND_DISPLAY = resolve(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY);
  return result;
}
