import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { windowEnv } from './owner.mjs';
import { launchDesktopGroup } from './desktop-launcher.mjs';
import { packageNative } from './package-native.mjs';
import { closePage } from './window-close.mjs';
export async function wait(condition, ms = 15000) {
  const until = Date.now() + ms;
  do {
    if (await condition()) return;
    await setTimeout(50);
  } while (Date.now() < until);
  throw Error('qualification timeout');
}
export async function currentWindow(f, label, executable) {
  const userData = join(f.root, 'desktop'),
    portFile = join(userData, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const env = {
    ...windowEnv(f),
    ...(executable
      ? {}
      : { NODE_OPTIONS: '--import=' + resolve('apps/desktop/qa/native-proof.mjs') }),
    OCEAN_QA_NATIVE_PROOF: join(f.root, 'native.jsonl'),
    OCEAN_QA_EXPORT: join(f.root, 'exports'),
  };
  const launcher = launchDesktopGroup(
    executable ?? 'pnpm',
    [
      ...(executable ? ['--inspect=0'] : ['--filter', '@ocean/desktop', 'start']),
      '--user-data-dir=' + userData,
      '--remote-debugging-port=0',
      '--ozone-platform=wayland',
    ],
    env,
  );
  let log = '';
  const add = (b) => {
    log += b;
    appendFileSync(join(f.root, label + '.log'), b);
  };
  launcher.proc.stdout.on('data', add);
  launcher.proc.stderr.on('data', add);
  const seen = new Set();
  function audit() {
    for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      if (seen.has(pid)) continue;
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]) !== launcher.proc.pid)
          continue;
        const pairs = readFileSync('/proc/' + pid + '/environ', 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]);
        if (
          !pairs.length &&
          readFileSync('/proc/' + pid + '/stat', 'utf8')
            .split(') ')[1]
            .startsWith('Z ')
        )
          continue;
        const cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
        // A process with neither environment nor argv is mid-teardown: it cannot
        // be a live Desktop child and would fail an otherwise unrelated audit race.
        if (!pairs.length && cmd[0] === '') continue;
        if (!pairs.some(([key]) => key === 'HOME') && cmd[0]?.includes(' --type=')) {
          appendFileSync(
            join(f.root, 'children.jsonl'),
            JSON.stringify({ pid, cmd, env: {}, sandboxRewrittenProcEnvironment: pairs }) + '\n',
          );
          seen.add(pid);
          continue;
        }
        const child = Object.fromEntries(pairs),
          selected = {};
        appendFileSync(
          join(f.root, 'children-observed.jsonl'),
          JSON.stringify({
            pid,
            cmd: readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0'),
            env: child,
          }) + '\n',
        );
        for (const key of [
          'HOME',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_CACHE_HOME',
          'XDG_STATE_HOME',
          'XDG_RUNTIME_DIR',
          'TMPDIR',
        ]) {
          assert.equal(child[key], f.env[key], pid + ':' + key);
          selected[key] = child[key];
        }
        assert.ok([undefined, 'disabled:'].includes(child.DBUS_SESSION_BUS_ADDRESS));
        selected.DBUS_SESSION_BUS_ADDRESS = child.DBUS_SESSION_BUS_ADDRESS;
        assert.equal(child.DEEPSEEK_API_KEY, undefined);
        appendFileSync(
          join(f.root, 'children.jsonl'),
          JSON.stringify({
            pid,
            cmd: readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0'),
            env: selected,
          }) + '\n',
        );
        seen.add(pid);
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  try {
    await wait(() => {
      audit();
      if (launcher.proc.exitCode !== null || launcher.proc.signalCode !== null)
        throw Error('Desktop exited ' + log.slice(-4000));
      return existsSync(portFile);
    }, 60000);
    const [port] = readFileSync(portFile, 'utf8').split('\n');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(port));
    const page =
      browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].waitForEvent('page'));
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) =>
      appendFileSync(join(f.root, 'page-errors.log'), String(error) + '\n'),
    );
    page.on('console', (msg) =>
      appendFileSync(join(f.root, 'renderer-console.log'), msg.type() + ':' + msg.text() + '\n'),
    );
    audit();
    if (executable) await packageNative(f, () => log);
    await wait(() => existsSync(join(f.root, 'native.jsonl')));
    const proof = readFileSync(join(f.root, 'native.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.ok(
      proof.some((x) => x.userData === userData),
      'actual app.getPath(userData) proof',
    );
    const preferences = proof.filter((x) => x.webPreferences).at(-1).webPreferences;
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
    return {
      page,
      userData,
      async close() {
        audit();
        await closePage(page);
        assert.equal(await launcher.waitForClose(), 0);
      },
      dispose: () => launcher.dispose(),
    };
  } catch (error) {
    writeFileSync(join(f.root, label + '-failure.log'), String(error));
    await launcher.dispose();
    throw error;
  }
}
