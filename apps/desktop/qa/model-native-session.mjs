import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { bounded, currentWindow, wait } from './current-window.mjs';
import { launchDesktopGroup } from './desktop-launcher.mjs';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (data) => createHash('sha256').update(data).digest('hex');
function directory(root) {
  mkdirSync(root, { mode: 0o700 });
  return root;
}
function verified(path) {
  assert.equal(realpathSync(path), path, 'explicit absolute canonical input required');
  return path;
}
function fresh(root) {
  assert.equal(resolve(root), root);
  verified(dirname(root));
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    assert.ok(
      !['.git', 'artifact-proof.json', 'desktop-artifact.json', 'identity.json', 'seal.json'].some(
        (name) => existsSync(join(dir, name)),
      ),
      'cannot write inside checkout or previous evidence',
    );
    const s = lstatSync(dir);
    assert.ok(
      [0, process.getuid()].includes(s.uid) && (!(s.mode & 0o022) || s.mode & 0o1000),
      'untrusted output ancestor',
    );
    if (dir === '/') break;
  }
  directory(root);
}
function artifact(root) {
  verified(root);
  const manifest = json(join(root, 'manifest.json'));
  assert.equal(manifest.node, process.version);
  for (const [name, record] of Object.entries(manifest.files)) {
    const file = verified(join(root, name));
    assert.ok(file.startsWith(root + '/'));
    assert.equal(digest(readFileSync(file)), record.sha256, name);
  }
  return manifest.revision;
}
export function saveProof(root, name, data) {
  assert.match(name, /^[a-z0-9-]+\.json$/);
  writeFileSync(join(root, name), JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
export async function openModelNativeSession({
  installedRoot,
  runtimeRoot = installedRoot,
  desktopExecutable,
  root,
  label = 'desktop',
  ownerHook,
}) {
  assert.match(label, /^[a-z][a-z0-9-]{0,40}$/);
  verified(desktopExecutable);
  const sdkRevision = artifact(installedRoot);
  const runtimeRevision = runtimeRoot === installedRoot ? sdkRevision : artifact(runtimeRoot);
  const pkg = verified(join(installedRoot, 'node_modules/@runnets/tools-node'));
  const sdk = verified(
    join(pkg, json(join(pkg, 'package.json')).exports['./local-runtime-client'].import),
  );
  assert.ok(sdk.startsWith(pkg + '/'));
  const socket = resolve(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY);
  assert.ok(lstatSync(socket).isSocket());
  for (const input of [installedRoot, runtimeRoot, dirname(desktopExecutable)])
    assert.ok(
      root !== input && !root.startsWith(input + '/'),
      'proof root overlaps an artifact input',
    );
  fresh(root);
  const short = mkdtempSync('/tmp/oa-native-');
  let desktop,
    owner,
    peer,
    authenticated = false,
    disposed = false;
  const failures = [];
  const profile = join(root, 'profile'),
    workspace = directory(join(root, 'workspace'));
  const env = {
    PATH: dirname(process.execPath) + ':/usr/bin',
    LANG: 'C.UTF-8',
    DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
  };
  for (const [key, path] of Object.entries({
    HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache',
    XDG_DATA_HOME: 'data',
    XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'run',
    TMPDIR: 'tmp',
  }))
    env[key] = directory(join(['run', 'tmp'].includes(path) ? short : root, path));
  directory(join(root, 'exports'));
  const fixture = {
    root,
    env,
    profile,
    windowEnv: { ...env, WAYLAND_DISPLAY: socket, OCEAN_DESKTOP_PROFILE: profile },
  };
  async function dispose(original) {
    if (disposed) return;
    disposed = true;
    async function attempt(fn) {
      try {
        await fn();
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (desktop) {
      await attempt(() => desktop.close());
      await attempt(() => desktop.dispose());
    }
    if (peer) {
      if (authenticated)
        await attempt(async () => assert.equal((await peer.stop()).outcome, 'complete'));
      await attempt(() => peer.close());
    }
    if (owner) {
      if (authenticated) await attempt(async () => assert.equal(await owner.waitForClose(5000), 0));
      await attempt(() => owner.dispose(5000));
    }
    if (!failures.length && !original?.cleanupError)
      await attempt(() => rmSync(short, { recursive: true }));
    await attempt(() =>
      saveProof(root, 'cleanup.json', {
        original: original && String(original),
        attached: original?.cleanupError && String(original.cleanupError),
        failures,
        short,
        owner: owner?.records(),
        desktop: desktop?.records() ?? original?.desktopRecords,
      }),
    );
    if (failures.length) {
      const error = Error('native cleanup: ' + failures.join('; '));
      if (original) original.cleanupError = error;
      else throw error;
    }
  }
  try {
    const cli = join(runtimeRoot, 'launch.js');
    const args = ['--profile', profile, '--json'];
    const init = JSON.parse(
      execFileSync(process.execPath, [cli, 'init', '--workspace', workspace, ...args], {
        env,
        encoding: 'utf8',
        timeout: 15000,
        killSignal: 'SIGKILL',
      }),
    );
    assert.equal(init.ok, true);
    const hook = verified(ownerHook ?? join(import.meta.dirname, 'model-native-transport.mjs'));
    owner = launchDesktopGroup(
      process.execPath,
      ['--import', hook, cli, 'runtime', 'start', ...args],
      { ...env, OCEAN_NATIVE_REQUESTS: join(root, 'requests.jsonl') },
      { track: true },
    );
    let output = '';
    owner.proc.stdout.on('data', (b) => {
      output = (output + b).slice(-65536);
      appendFileSync(join(root, 'owner.log'), b);
    });
    owner.proc.stderr.on('data', (b) => appendFileSync(join(root, 'owner.log'), b));
    await wait(() => {
      if (owner.proc.exitCode !== null || owner.proc.signalCode !== null)
        throw Error('installed owner exited before readiness');
      return output.includes('\n');
    }, 20000);
    const ready = JSON.parse(output.split('\n')[0]).data;
    assert.equal(ready.state, 'ready');
    assert.equal(ready.profileId, digest(profile));
    const { connectLocalRuntime } = await import(pathToFileURL(sdk));
    // Registry resolution is synchronous at connect invocation; restore the caller immediately.
    const previous = process.env.XDG_RUNTIME_DIR;
    let connecting;
    const abort = new globalThis.AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
      connecting = connectLocalRuntime({ profile, signal: abort.signal });
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
    try {
      peer = await connecting;
    } finally {
      clearTimeout(timer);
    }
    const status = await peer.status();
    assert.equal(status.profileId, ready.profileId);
    assert.equal(status.instanceId, ready.instanceId);
    authenticated = true;
    desktop = await currentWindow(fixture, label, desktopExecutable);
    const { page, inspectMain } = desktop;
    assert.equal(await inspectMain('process.versions.electron'), '45.2.1');
    assert.equal(await inspectMain('process.env.OCEAN_DESKTOP_PROFILE'), profile);
    const gui = await bounded(
      page.evaluate(() => globalThis.ocean.request({ op: 'status' })),
      15000,
      'GUI status',
    );
    assert.equal(gui.ok, true);
    assert.equal(gui.data.instanceId, status.instanceId);
    assert.equal(gui.data.profileId, digest(profile));
    await page.getByRole('heading', { name: 'Начните с Ocean Team' }).waitFor();
    const body = await page.locator('body').innerText();
    assert.ok(body.trim().length > 30 && !body.includes('Internal Server Error'));
    assert.ok(
      page
        .url()
        .startsWith(
          pathToFileURL(join(dirname(desktopExecutable), 'resources/app.asar')).href + '/',
        ),
    );
    saveProof(root, 'identity.json', {
      root,
      profile,
      env,
      cli,
      sdk,
      sdkRevision,
      runtimeRevision,
      hook,
      desktopExecutable,
      ownerPid: owner.proc.pid,
      desktopPid: desktop.pid,
      status,
      gui: gui.data,
      url: page.url(),
      title: await page.title(),
      body,
    });
    return { page, peer, fixture, desktop, inspectMain, dispose };
  } catch (error) {
    try {
      await dispose(error);
    } catch (cleanup) {
      error.cleanupError = cleanup;
    }
    throw error;
  }
}
