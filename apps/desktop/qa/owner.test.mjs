import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
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

test('a never-ready owner with refused stop is retired and awaited before startup rejects', async (t) => {
  const parent = mkdtempSync(
    join(process.env.OCEAN_QA_FAILURE_ROOT ?? tmpdir(), 'owner-start-refusal-'),
  );
  const cli = join(parent, 'fake-cli.mjs');
  writeFileSync(
    cli,
    `
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const words=process.argv.slice(2), profile=words[words.indexOf('--profile')+1];
    if(words[0]==='init'){
      mkdirSync(profile,{recursive:true,mode:0o700});
      console.log(JSON.stringify({data:{}}));
    } else if(words[1]==='start'){
      const stat=readFileSync('/proc/self/stat','utf8');
      const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
      writeFileSync(join(profile,'owner-identity.json'),JSON.stringify({pid:process.pid,start}));
      writeFileSync(join(profile,'uncertain-evidence'),'retain original unknown outcome');
      console.log('fixture startup diagnostic');
      setInterval(()=>{},1000);
    } else {
      console.log(JSON.stringify({data:{state:'stop_incomplete',outcome:'uncertain'}}));
      process.exitCode=4;
    }
  `,
  );
  let identity, root, startup;
  const sameOwner = () => {
    try {
      const stat = readFileSync('/proc/' + identity.pid + '/stat', 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === identity.start;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  };
  try {
    try {
      await fixture({ cli, root: parent, preserve: false });
    } catch (error) {
      startup = error;
    }
    root = join(
      parent,
      readdirSync(parent).find((name) => name.startsWith('ocean-gui-')),
    );
    identity = JSON.parse(readFileSync(join(root, 'profile', 'owner-identity.json'), 'utf8'));
    const aliveAfterRejection = sameOwner();
    writeFileSync(
      join(parent, 'regression-proof.json'),
      JSON.stringify({ root, identity, aliveAfterRejection }, null, 2),
    );
    assert.equal(
      aliveAfterRejection,
      false,
      'factory rejected while its exact owned owner was still alive',
    );
    assert.match(startup.message, /owner startup failed.*fixture startup diagnostic/s);
    assert.equal(startup.cause.status, 4);
    assert.equal(JSON.parse(startup.cause.stdout).data.outcome, 'uncertain');
    assert.match(
      readFileSync(join(root, 'startup-error.log'), 'utf8'),
      /fixture startup diagnostic/,
    );
    assert.match(readFileSync(join(root, 'owner.log'), 'utf8'), /fixture startup diagnostic/);
    const retired = JSON.parse(readFileSync(join(root, 'cleanup-owner-exit.json'), 'utf8'));
    assert.equal(retired.pid, identity.pid);
    assert.equal(retired.start, identity.start);
    assert.equal(retired.signalRequested, 'SIGKILL');
    assert.deepEqual(retired.outcome, { code: null, signal: 'SIGKILL' });
    assert.equal(
      readFileSync(join(root, 'profile', 'uncertain-evidence'), 'utf8'),
      'retain original unknown outcome',
    );
    assert.match(readFileSync(join(root, 'commands.jsonl'), 'utf8'), /stop_incomplete/);
  } finally {
    // RED cleanup reaches only the exact fake owner identified by its start time.
    if (identity && sameOwner()) {
      process.kill(identity.pid, 'SIGKILL');
      for (let i = 0; i < 100 && sameOwner(); i++) await setTimeout(10);
      assert.equal(sameOwner(), false);
    }
    t.diagnostic('retained startup refusal evidence: ' + parent);
  }
});
