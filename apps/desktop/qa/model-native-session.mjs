import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  nativeEnvironment,
  artifact,
  defaultQualificationParent,
  digest,
  directory,
  fresh,
  json,
  saveProof,
  verified,
} from './model-native-paths.mjs';
import { createNativeCase } from './model-native-case.mjs';
export { saveProof } from './model-native-paths.mjs';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { bounded, currentWindow, wait } from './current-window.mjs';
import { launchDesktopGroup } from './desktop-launcher.mjs';
const initializedProfiles = new Map();

export async function openModelNativeSession(
  {
    installedRoot,
    runtimeRoot = installedRoot,
    desktopExecutable,
    root,
    label = 'desktop',
    ownerHook,
    resumeProfile,
    resumeRuntimeDirectory,
    qualificationParent = defaultQualificationParent,
  },
  { setupDirectory = directory, appendEvidence = appendFileSync } = {},
) {
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
  const control = createNativeCase(),
    failures = [],
    sinkErrors = new Set();
  function sinkFailed(error) {
    sinkErrors.add(error);
    control.fail(error);
  }
  let short,
    desktop,
    owner,
    peer,
    authenticated = false,
    retirement,
    published = false;
  function dispose(original) {
    retirement ??= Promise.resolve().then(() => cleanup(original));
    return retirement;
  }
  control.signal.addEventListener(
    'abort',
    () => {
      if (published)
        void dispose(control.signal.reason).catch((e) => {
          if (e !== control.signal.reason) control.signal.reason.cleanupError = e;
        });
    },
    { once: true },
  );
  if (resumeProfile) assert.ok(initializedProfiles.has(resumeProfile), 'unowned resume profile');
  fresh(root, qualificationParent);
  async function cleanup(original) {
    async function attempt(fn) {
      try {
        await fn();
      } catch (e) {
        failures.push(e);
      }
    }
    if (control.signal.aborted && peer) await attempt(() => peer.close());
    if (desktop) {
      if (!control.signal.aborted && !desktop.page.isClosed()) await attempt(() => desktop.close());
      await attempt(() => desktop.dispose());
    }
    if (peer) {
      if (authenticated && !control.signal.aborted)
        await attempt(async () => assert.equal((await peer.stop()).outcome, 'complete'));
      await attempt(() => peer.close());
    }
    if (owner) {
      if (authenticated && !control.signal.aborted)
        await attempt(async () => assert.equal(await owner.waitForClose(5000), 0));
      await attempt(() => owner.dispose(5000));
    }
    if (short && !failures.length && !original?.cleanupError)
      await attempt(() => rmSync(short, { recursive: true }));
    const primary = original ?? control.signal.reason;
    for (const error of sinkErrors)
      if (error !== primary && !failures.includes(error)) failures.push(error);
    await attempt(() =>
      saveProof(root, 'cleanup.json', {
        original: primary && String(primary),
        interrupted: control.signal.aborted,
        attached: original?.cleanupError && String(original.cleanupError),
        failures: failures.map(String),
        short,
        owner: owner?.records(),
        desktop: desktop?.records() ?? original?.desktopRecords,
      }),
    );
    if (failures.length) {
      if (primary?.cleanupError) failures.unshift(primary.cleanupError);
      const error = new AggregateError(failures, 'native cleanup: ' + failures.join('; '));
      if (primary) primary.cleanupError = error;
      else throw error;
    }
    if (!original && primary) throw primary;
  }
  try {
    short = mkdtempSync('/tmp/oa-native-');
    const profile = resumeProfile ?? join(root, 'profile'),
      workspace = join(root, 'workspace');
    setupDirectory(workspace);
    if (resumeRuntimeDirectory) {
      assert.equal(
        initializedProfiles.get(resumeProfile),
        resumeRuntimeDirectory,
        'unowned runtime directory',
      );
      const stat = lstatSync(resumeRuntimeDirectory);
      assert.ok(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077));
    }
    const env = nativeEnvironment(root, short, setupDirectory, resumeRuntimeDirectory);
    setupDirectory(join(root, 'exports'));
    const fixture = {
      root,
      env,
      profile,
      desktopUserData: resumeProfile ? join(dirname(resumeProfile), 'desktop') : undefined,
      signal: control.signal,
      fail: sinkFailed,
      inspectorStep: control.step,
      appendEvidence,
      windowEnv: { ...env, WAYLAND_DISPLAY: socket, OCEAN_DESKTOP_PROFILE: profile },
    };
    const cli = join(runtimeRoot, 'launch.js');
    const args = ['--profile', profile, '--json'];
    const init = resumeProfile
      ? { ok: true }
      : JSON.parse(
          execFileSync(process.execPath, [cli, 'init', '--workspace', workspace, ...args], {
            env,
            encoding: 'utf8',
            timeout: 15000,
            killSignal: 'SIGKILL',
          }),
        );
    assert.equal(init.ok, true);
    if (!resumeProfile) initializedProfiles.set(profile, env.XDG_RUNTIME_DIR);
    const hook = verified(ownerHook ?? join(import.meta.dirname, 'model-native-transport.mjs'));
    owner = launchDesktopGroup(
      process.execPath,
      ['--import', hook, cli, 'runtime', 'start', ...args],
      { ...env, OCEAN_NATIVE_REQUESTS: join(root, 'requests.jsonl') },
      { track: true },
    );
    saveProof(root, 'owner-launch.json', owner.launch);
    if (owner.launch.observation !== 'observed')
      throw Error('owner launch identity ' + owner.launch.observation);
    function log(bytes) {
      try {
        appendEvidence(join(root, 'owner.log'), bytes);
      } catch (error) {
        sinkFailed(error);
      }
    }
    let output = '';
    owner.proc.stdout.on('data', (b) => {
      output = (output + b).slice(-65536);
      log(b);
    });
    owner.proc.stderr.on('data', log);
    await wait(() => {
      control.signal.throwIfAborted();
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
    control.signal.throwIfAborted();
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
    if (!resumeProfile) await page.getByRole('heading', { name: 'Начните с Ocean Team' }).waitFor();
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
      title: await bounded(page.title(), 15000, 'page title'),
      body,
    });
    control.signal.throwIfAborted();
    published = true;
    return {
      page,
      peer,
      fixture,
      desktop,
      inspectMain,
      dispose,
      signal: control.signal,
      runCase: (work, ms = 120000) => control.run(work, ms, dispose),
    };
  } catch (observed) {
    const error = control.signal.aborted ? control.signal.reason : observed;
    if (observed !== error && observed.desktopRecords)
      error.desktopRecords = observed.desktopRecords;
    if (observed !== error && observed.cleanupError) error.cleanupError = observed.cleanupError;
    try {
      await dispose(error);
    } catch (cleanup) {
      error.cleanupError = cleanup;
    }
    throw error;
  }
}
