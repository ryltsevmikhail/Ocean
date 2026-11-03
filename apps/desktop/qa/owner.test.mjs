import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fixture, windowEnv } from './owner.mjs';

test('GUI keeps fixture HOME, every XDG directory and TMPDIR without forwarding user bus', () => {
  const env = Object.fromEntries(
    [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
      'TMPDIR',
    ].map((k) => [k, '/owned/' + k]),
  );
  const actual = windowEnv({ env, profile: '/owned/profile' });
  for (const [key, value] of Object.entries(env)) assert.equal(actual[key], value, key);
  assert.equal(actual.DBUS_SESSION_BUS_ADDRESS, undefined);
});

test('installed CLI owner and every child inherit private directories; preserved fixture is reviewable', async () => {
  const cli = process.env.OCEAN_QA_CLI ?? resolve('apps/cli/dist/main.js');
  const f = await fixture({ cli, preserve: true });
  try {
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
      'TMPDIR',
    ]) {
      assert.ok(f.env[key].startsWith(f.root + '/'), key);
      assert.ok(existsSync(f.env[key]), key);
    }
    const inherited = Object.fromEntries(
      readFileSync('/proc/' + f.owner.pid + '/environ', 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]),
    );
    for (const key of Object.keys(f.env)) assert.equal(inherited[key], f.env[key], key);
    assert.equal(inherited.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(f.cli, cli);
  } finally {
    await f.close();
  }
  assert.ok(existsSync(join(f.root, 'owner.log')));
  rmSync(f.root, { recursive: true, force: true });
});
