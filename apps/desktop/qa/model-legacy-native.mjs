import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { existsSync, lstatSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { artifact, directory, fresh, json } from './model-native-paths.mjs';
import { currentWindow, wait } from './current-window.mjs';
import { launchDesktopGroup } from './desktop-launcher.mjs';
const { values } = parseArgs({
  options: {
    'installed-root': { type: 'string' },
    'historical-root': { type: 'string' },
    'unsafe-root': { type: 'string' },
    desktop: { type: 'string' },
    root: { type: 'string' },
  },
});
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const supported = await openModelNativeSession({
  installedRoot: values['installed-root'],
  runtimeRoot: values['historical-root'],
  desktopExecutable: values.desktop,
  root: values.root,
});
let original;
try {
  await supported.runCase(async (step) => {
    assert.ok(supported.peer.identity.capabilities.includes('plugin.session-authority-v1'));
    assert.ok(!supported.peer.identity.capabilities.includes('model.connections-v1'));
    const { page, peer } = supported;
    await step(() => button(page, 'Провайдер').click());
    const dlg = page.getByRole('dialog', { name: 'Провайдер' });
    await step(() => dlg.getByRole('heading', { name: 'DeepSeek', exact: true }).waitFor());
    assert.equal(
      await step(() => dlg.getByRole('heading', { name: 'Подключения и модели ботов' }).count()),
      0,
    );
    await step(() => dlg.getByLabel('Ключ API').fill('synthetic-historical-key'));
    await step(() => button(dlg, 'Сохранить').click());
    await wait(() => step(() => dlg.getByLabel('Ключ API').isEnabled()), 5000);
    assert.equal(await step(() => dlg.getByLabel('Ключ API').inputValue()), '');
    const status = await step(() => peer.providerStatus());
    assert.equal(status.savedKey, true);
    assert.equal(status.state, 'connected');
    const forbidden = await step(() =>
      page.evaluate(() =>
        globalThis.ocean.request({
          op: 'model-set',
          input: {
            connectionId: 'forbidden',
            requestId: 'legacy-new-api',
            expectedRevision: null,
            kind: 'local',
            providerId: 'ollama',
            endpoint: 'http://127.0.0.1:11434',
            auth: 'none',
            defaultModelId: 'qwen3:1.7b',
          },
        }),
      ),
    );
    assert.equal(forbidden.error.code, 'model_runtime_upgrade_required');
    await step(() => page.screenshot({ path: join(values.root, 'supported-legacy.png') }));
    saveProof(values.root, 'legacy.json', {
      synthetic: true,
      identity: peer.identity,
      status,
      forbidden,
    });
  });
} catch (error) {
  original = error;
  throw error;
} finally {
  await supported.dispose(original);
}
// Actual RC2 host in a new RC2-initialized profile. Current SDK refuses its unsafe plugin protocol.
const root = values.root + '-unsafe',
  parent = dirname(root);
fresh(root, parent);
const short = mkdtempSync('/tmp/oa-legacy-');
const env = {
  PATH: dirname(process.execPath) + ':/usr/bin',
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
  directory(env[key]);
}
const revision = artifact(values['unsafe-root']);
const profile = join(root, 'profile'),
  workspace = join(root, 'workspace');
directory(workspace);
const cli = join(values['unsafe-root'], 'launch.js');
const command = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, ...args, '--profile', profile, '--json'], {
      env,
      encoding: 'utf8',
      timeout: 15000,
      killSignal: 'SIGKILL',
    }),
  );
assert.equal(command('init', '--workspace', workspace).ok, true);
const owner = launchDesktopGroup(
  process.execPath,
  [cli, 'runtime', 'start', '--profile', profile, '--json'],
  env,
  { track: true },
);
let log = '',
  desktop,
  failure;
owner.proc.stdout.on('data', (b) => {
  log += b;
});
owner.proc.stderr.on('data', (b) => {
  log += b;
});
try {
  await wait(() => log.includes('\n'), 15000);
  const identity = JSON.parse(log.split('\n')[0]).data;
  assert.ok(!identity.capabilities.includes('plugin.session-authority-v1'));
  const pkg = join(values['installed-root'], 'node_modules/@runnets/tools-node');
  const { connectLocalRuntime } = await import(
    pathToFileURL(
      join(pkg, json(join(pkg, 'package.json')).exports['./local-runtime-client'].import),
    )
  );
  const previous = process.env.XDG_RUNTIME_DIR;
  let connecting;
  try {
    process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
    connecting = connectLocalRuntime({ profile });
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  }
  await assert.rejects(connecting, /plugin_runtime_upgrade_required/);
  const socket = resolve(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY);
  assert.ok(lstatSync(socket).isSocket());
  desktop = await currentWindow(
    {
      root,
      env,
      profile,
      windowEnv: { ...env, WAYLAND_DISPLAY: socket, OCEAN_DESKTOP_PROFILE: profile },
    },
    'unsafe',
    values.desktop,
  );
  const { page } = desktop;
  await page.getByText(/plugin_runtime_upgrade_required/).waitFor();
  assert.ok(await button(page, 'Провайдер').isDisabled());
  const refusal = await page.locator('body').innerText();
  assert.match(refusal, /plugin_runtime_upgrade_required/);
  assert.equal(await page.getByLabel('Ключ API').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Сохранить', exact: true }).count(), 0);
  const mutation = await page.evaluate(() =>
    globalThis.ocean.request({
      op: 'provider-set',
      requestId: 'unsafe-write',
      model: 'deepseek-flash',
      key: 'synthetic-forbidden',
    }),
  );
  assert.equal(mutation.ok, false);
  assert.equal(mutation.error.code, 'plugin_runtime_upgrade_required');
  await page.screenshot({ path: join(root, 'unsupported-refusal.png') });
  saveProof(root, 'unsafe.json', { revision, identity, refusal, mutation, profile, cli });
} catch (error) {
  failure = error;
  throw error;
} finally {
  const failures = [];
  if (desktop) {
    try {
      await desktop.close();
    } catch (error) {
      failures.push(String(error));
    }
    try {
      await desktop.dispose();
    } catch (error) {
      failures.push(String(error));
    }
  }
  try {
    assert.equal(command('runtime', 'stop').ok, true);
    await owner.waitForClose(5000);
  } catch (error) {
    failures.push(String(error));
  }
  try {
    await owner.dispose(5000);
  } catch (error) {
    failures.push(String(error));
  }
  saveProof(root, 'cleanup.json', {
    failure: failure && String(failure),
    failures,
    owner: owner.records(),
    desktop: desktop?.records(),
    log,
  });
  if (!failures.length) rmSync(short, { recursive: true });
  if (!failure) assert.deepEqual(failures, []);
  assert.ok(!existsSync(join(root, 'page-errors.log')));
  const console = existsSync(join(root, 'renderer-console.log'))
    ? readFileSync(join(root, 'renderer-console.log'), 'utf8')
    : '';
  assert.doesNotMatch(console, /^error:/m);
}
