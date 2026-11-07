import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { processIdentity } from './desktop-launcher.mjs';
import { openModelNativeSession } from './model-native-session.mjs';

test('direct process identity distinguishes disappearance from unavailable evidence', () => {
  assert.equal(
    processIdentity(123, () => {
      throw Object.assign(Error('gone'), { code: 'ENOENT' });
    }),
    null,
  );
  assert.throws(
    () =>
      processIdentity(123, () => {
        throw Object.assign(Error('denied'), { code: 'EACCES' });
      }),
    /denied/,
  );
  assert.throws(() => processIdentity(123, () => ''), /invalid process identity/);
});
for (const stage of [
  'resume',
  'readiness',
  'fast-owner',
  'proof-sink',
  'retirement-sink',
  'launch',
  'mismatch',
  'existing',
  'symlink',
  'prior-proof',
  'profile',
  'setup',
  'owner-sink',
  'desktop-sink',
]) {
  test('owned native session: ' + stage, async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'native-failure-'));
    const socket = join(base, 'wayland'),
      server = createServer(),
      original = process.env.WAYLAND_DISPLAY;
    const oldRun = process.env.XDG_RUNTIME_DIR;
    await new Promise((resolve) => server.listen(socket, resolve));
    let short;
    try {
      process.env.WAYLAND_DISPLAY = socket;
      process.env.XDG_RUNTIME_DIR = base;
      const installedRoot = join(base, 'installed');
      mkdirSync(installedRoot);
      const files = {
        'launch.js': `import fs from 'node:fs';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
        const profile=process.argv[process.argv.indexOf('--profile')+1];
        if(process.argv[2]==='init'){ fs.mkdirSync(profile);console.log(JSON.stringify({ok:true}));}
        else if(${JSON.stringify(stage)}==='fast-owner') process.exit(7);
        else if(${JSON.stringify(stage)}==='readiness'){
          const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log(process.pid);setInterval(()=>{},1000)"]);
          child.stdout.once('data',b=>{fs.writeFileSync(profile+'/child',b);setTimeout(()=>process.exit(2),350);});
        } else {
          console.log(JSON.stringify({data:{profileId:createHash('sha256').update(profile).digest('hex'),instanceId:'qa',state:'ready'}}));
          setInterval(()=>{if(fs.existsSync(profile+'/stop')){
            if(${JSON.stringify(stage)}==='retirement-sink') process.stderr.write('retiring',()=>process.exit(4));
            else process.exit(0);
          }},20);
          setTimeout(()=>process.exit(3),3000).unref();
        }`,
        'package.json': '{"type":"module"}',
        'node_modules/@runnets/tools-node/package.json':
          '{"type":"module","exports":{"./local-runtime-client":{"import":"./client.js"}}}',
        'node_modules/@runnets/tools-node/client.js': `import {createHash} from 'node:crypto';import {writeFileSync} from 'node:fs';
          export function connectLocalRuntime({profile}) {return {status:async()=>({profileId:createHash('sha256').update(profile).digest('hex'),instanceId:${JSON.stringify(stage === 'mismatch' ? 'wrong' : 'qa')}}),
            stop:async()=>{writeFileSync(profile+'/stop','');return {outcome:'complete'};},close(){}};}`,
      };
      const inventory = {};
      for (const [name, bytes] of Object.entries(files)) {
        const path = join(installedRoot, name);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, bytes);
        inventory[name] = { sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      writeFileSync(
        join(installedRoot, 'manifest.json'),
        JSON.stringify({ node: process.version, revision: 'fixture', files: inventory }),
      );
      let root = join(base, 'proof');
      if (stage === 'existing') mkdirSync(root);
      if (stage === 'symlink') {
        symlinkSync(base, join(base, 'link'));
        root = join(base, 'link', 'new');
      }
      if (stage === 'prior-proof' || stage === 'profile') {
        const prior = join(base, stage);
        mkdirSync(prior);
        root = join(prior, 'new');
      }
      let injected = false;
      const fsFault = Object.assign(Error('fixture evidence sink full'), { code: 'ENOSPC' });
      const options = {
        setupDirectory(path) {
          if (path.endsWith('/run')) short = join(path, '..');
          if (stage === 'setup' && path.endsWith('/run')) {
            injected = true;
            throw fsFault;
          }
          mkdirSync(path, { mode: 0o700 });
        },
        appendEvidence(path, bytes) {
          if (stage === 'retirement-sink' && bytes.toString().includes('retiring'))
            throw Object.assign(Error('retirement log EIO'), { code: 'EIO' });
          if (stage === 'proof-sink' && path.endsWith('/owner.log')) {
            if (!injected) mkdirSync(join(root, 'cleanup.json'));
            injected = true;
            throw fsFault;
          }
          if (
            (stage === 'owner-sink' && path.endsWith('/owner.log')) ||
            (stage === 'desktop-sink' && path.endsWith('/native.log'))
          ) {
            injected = true;
            throw fsFault;
          }
          writeFileSync(path, bytes, { flag: 'a' });
        },
      };
      let executable = '/usr/bin/false';
      if (stage === 'desktop-sink') {
        mkdirSync(join(base, 'bin'));
        executable = join(base, 'bin', 'emit');
        writeFileSync(executable, '#!/bin/sh\nprintf evidence\nsleep 2\n', { mode: 0o700 });
      }
      const run = () =>
        openModelNativeSession(
          {
            installedRoot,
            qualificationParent: base,
            desktopExecutable: executable,
            root,
            label: 'native',
            ...(stage === 'resume' ? { resumeProfile: join(base, 'retained', 'profile') } : {}),
          },
          options,
        );
      if (stage === 'resume') {
        await assert.rejects(run, /unowned resume profile/);
        assert.equal(existsSync(root), false);
        return;
      }
      if (stage === 'prior-proof' || stage === 'profile') {
        await assert.rejects(run, /direct child/);
        assert.deepEqual(readdirSync(join(base, stage)), []);
        return;
      }
      if (stage === 'existing' || stage === 'symlink') {
        await assert.rejects(run, stage === 'existing' ? /EEXIST/ : /canonical|direct child/);
        assert.equal(existsSync(join(root, 'workspace')), false);
        return;
      }
      if (stage === 'proof-sink') {
        await assert.rejects(
          run,
          (error) => error === fsFault && error.cleanupError?.message.includes('EEXIST'),
        );
        const launch = JSON.parse(readFileSync(join(root, 'owner-launch.json'), 'utf8'));
        assert.notEqual(processIdentity(launch.pid)?.start, launch.start);
        assert.equal(existsSync(short), false);
        t.diagnostic(
          JSON.stringify({
            stage,
            launch,
            shortRetired: true,
            primary: fsFault.code,
            cleanup: String(fsFault.cleanupError),
          }),
        );
        return;
      }
      if (stage === 'retirement-sink') {
        let primary;
        await assert.rejects(run, (error) => {
          primary = error;
          return /Desktop exited/.test(error.message);
        });
        const ledger = JSON.parse(readFileSync(join(root, 'cleanup.json'), 'utf8'));
        assert.equal(ledger.original, String(primary));
        assert.ok(ledger.failures.some((message) => message.includes('retirement log EIO')));
        assert.ok(ledger.failures.some((message) => message.includes('AssertionError')));
        assert.match(primary.cleanupError.message, /retirement log EIO/);
        assert.ok(primary.cleanupError.errors.some((error) => error.code === 'EIO'));
        return;
      }
      const ioFailure = ['setup', 'owner-sink', 'desktop-sink'].includes(stage);
      await assert.rejects(
        run,
        ioFailure
          ? (err) => err === fsFault
          : ['readiness', 'fast-owner'].includes(stage)
            ? /before readiness/
            : stage === 'mismatch'
              ? /wrong/
              : /Desktop exited/,
      );
      const ledger = JSON.parse(readFileSync(join(root, 'cleanup.json'), 'utf8'));
      assert.deepEqual(ledger.failures, []);
      assert.equal(existsSync(ledger.short), false);
      if (ioFailure) assert.ok(injected);
      t.diagnostic(
        JSON.stringify({
          stage,
          original: ledger.original,
          failures: ledger.failures,
          shortAbsent: !existsSync(ledger.short),
          owner: ledger.owner,
          desktop: ledger.desktop,
        }),
      );
      if (stage === 'setup') {
        assert.equal(existsSync(short), false);
        return;
      }
      const leaders =
        stage === 'launch' || stage === 'desktop-sink' ? ['owner', 'desktop'] : ['owner'];
      for (const role of leaders) {
        const launch = JSON.parse(readFileSync(join(root, role + '-launch.json'), 'utf8'));
        assert.equal(launch.observation, 'observed');
        assert.ok(
          ledger[role].some(
            (row) =>
              row.pid === launch.pid && row.pid === launch.session && row.start === launch.start,
          ),
          'missing ' + role + ' launch identity',
        );
        for (const row of ledger[role]) assert.notEqual(processIdentity(row.pid)?.start, row.start);
      }
      if (stage === 'readiness') {
        const child = Number(readFileSync(join(root, 'profile', 'child'), 'utf8'));
        assert.ok(
          ledger.owner.some((x) => x.pid === child),
          'observed child survived the leader',
        );
      }
      if (stage === 'mismatch') assert.equal(existsSync(join(root, 'profile', 'stop')), false);
      for (const row of ledger.owner) assert.notEqual(processIdentity(row.pid)?.start, row.start);
    } finally {
      if (original === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = original;
      if (oldRun === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRun;
      await new Promise((resolve) => server.close(resolve));
      if (short) rmSync(short, { recursive: true, force: true });
      rmSync(base, { recursive: true });
    }
  });
}
