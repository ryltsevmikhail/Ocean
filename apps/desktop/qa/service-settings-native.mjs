// One owned current-source entry; no installed artifact or user profile is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
import { currentWindow, wait } from './current-window.mjs';
import { launchDesktopGroup, processIdentity } from './desktop-launcher.mjs';
import { fresh, defaultQualificationParent, saveProof } from './model-native-paths.mjs';
import { serviceSettingsCredentials } from './service-settings-credentials.mjs';
import { serviceSettingsDelta } from './service-settings-delta.mjs';
import { serviceSettingsFlow } from './service-settings-flow.mjs';
const [root, wayland, electron, mode] = process.argv.slice(2);
assert.ok(wayland?.startsWith('/'));
fresh(root, defaultQualificationParent);
const short = mkdtempSync('/tmp/oa-service-');
const env = {
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
  DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
};
for (const [key, name] of Object.entries({
  HOME: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
  XDG_RUNTIME_DIR: 'run',
  TMPDIR: 'tmp',
})) {
  env[key] = join(['run', 'tmp'].includes(name) ? short : root, name);
  mkdirSync(env[key], { mode: 0o700 });
}
const profile = join(root, 'profile'),
  workspace = join(root, 'workspace');
mkdirSync(workspace, { mode: 0o700 });
mkdirSync(join(root, 'exports'), { mode: 0o700 });
assert.ok(electron?.startsWith('/'));
const entry = join(root, 'current-desktop-entry');
writeFileSync(
  entry,
  '#!/bin/sh\nexec ' +
    JSON.stringify(electron) +
    ' ' +
    JSON.stringify(resolve('apps/desktop')) +
    ' "$@"\n',
  { mode: 0o700 },
);
const source = execFileSync('git', ['diff', '--', 'apps/desktop'], { encoding: 'utf8' });
saveProof(root, 'pins.json', {
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  desktopWorkingDiffSha256: createHash('sha256').update(source).digest('hex'),
  entry,
  electron,
  cli: resolve('apps/cli/dist/main.js'),
  sharedClient: resolve('packages/tools-node/dist/local-runtime-client.js'),
  hashes: Object.fromEntries(
    [
      'apps/desktop/dist/types/host/main.js',
      'apps/desktop/dist/types/host/service-settings-client.js',
      'apps/desktop/dist/web/index.html',
      'packages/tools-node/dist/local-service-client.js',
      'apps/cli/dist/local-runtime/host.js',
    ].map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
  ),
});
const owner = launchDesktopGroup(
  process.execPath,
  [resolve('apps/desktop/qa/service-settings-owner.mjs'), root, profile, workspace],
  env,
  { track: true },
);
saveProof(root, 'owner-launch.json', owner.launch);
const windows = [];
let log = '',
  peer,
  first,
  failure;
owner.proc.stdout.on('data', (b) => {
  log += b;
  appendFileSync(join(root, 'owner.log'), b);
});
owner.proc.stderr.on('data', (b) => appendFileSync(join(root, 'owner.log'), b));
try {
  await wait(() => {
    if (owner.proc.exitCode !== null)
      throw Error('owner exited ' + readFileSync(join(root, 'owner.log'), 'utf8'));
    return log.includes('ready\n');
  }, 20000);
  const ready = JSON.parse(readFileSync(join(root, 'owner-ready.json'), 'utf8'));
  const before = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
  try {
    peer = await connectLocalRuntime({ profile });
  } finally {
    process.env.XDG_RUNTIME_DIR = before;
  }
  const f = {
    root,
    env,
    profile,
    windowEnv: { ...env, WAYLAND_DISPLAY: wayland, OCEAN_DESKTOP_PROFILE: profile },
  };
  let windowNumber = 0;
  async function openWindow(label, userData = join(root, 'desktop')) {
    const windowRoot = join(root, 'window-' + ++windowNumber);
    mkdirSync(windowRoot, { mode: 0o700 });
    mkdirSync(join(windowRoot, 'exports'), { mode: 0o700 });
    const gui = await currentWindow(
      { ...f, root: windowRoot, desktopUserData: userData },
      label,
      entry,
    );
    windows.push(gui);
    return gui;
  }
  first = await openWindow('first');
  const identity = await first.page.evaluate(() => globalThis.ocean.request({ op: 'status' }));
  assert.equal(identity.ok, true);
  assert.equal(identity.data.instanceId, ready.identity.instanceId);
  saveProof(root, 'identity.json', {
    ready,
    gui: identity.data,
    actualVersions: await first.inspectMain('process.versions'),
    currentSourceUrl: first.page.url(),
  });
  const independent = (action, input) => {
    const path = join(root, 'independent-' + action + '.json');
    if (input) writeFileSync(path, JSON.stringify(input));
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve('apps/desktop/qa/service-settings-peer.mjs'),
          profile,
          action,
          ...(input ? [path] : []),
        ],
        { env, encoding: 'utf8', timeout: 15000 },
      ),
    );
  };
  const flow =
    mode === 'fix1'
      ? serviceSettingsCredentials
      : mode === 'delta'
        ? serviceSettingsDelta
        : serviceSettingsFlow;
  const result = await flow({
    root,
    ready,
    peer,
    first,
    independent,
    reopenFirst: async () => (first = await openWindow('first-reopened')),
  });
  saveProof(root, 'result.json', result);
} catch (e) {
  failure = e;
  if (first && !first.page.isClosed()) {
    writeFileSync(join(root, 'failure-body.txt'), await first.page.locator('body').innerText());
    await first.page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  }
  writeFileSync(join(root, 'failure.log'), e.stack ?? String(e));
} finally {
  const errors = [];
  for (const gui of windows) {
    try {
      if (!gui.page.isClosed()) await gui.close();
      await gui.dispose();
    } catch (e) {
      errors.push(String(e));
    }
  }
  try {
    if (peer) {
      writeFileSync(join(root, 'release-effect'), 'release');
      const stop = await peer.stop();
      assert.equal(stop.outcome, 'complete');
      peer.close();
      assert.equal(await owner.waitForClose(5000), 0);
    }
  } catch (e) {
    errors.push(String(e));
  }
  try {
    await owner.dispose(5000);
  } catch (e) {
    errors.push(String(e));
  }
  saveProof(root, 'cleanup.json', {
    failure: failure && String(failure),
    errors,
    short,
    owner: owner.records(),
    windows: windows.map((gui) => gui.records()),
    remaining: [...owner.records(), ...windows.flatMap((gui) => gui.records())]
      .map((r) => ({ pid: r.pid, start: r.start, current: processIdentity(r.pid) }))
      .filter((r) => r.current?.start === r.start),
  });
  if (!errors.length) rmSync(short, { recursive: true });
  if (errors.length && !failure) failure = Error('cleanup unknown: ' + errors.join('; '));
}
if (failure) throw failure;
console.log('PASS current-source service GUI ' + root);
