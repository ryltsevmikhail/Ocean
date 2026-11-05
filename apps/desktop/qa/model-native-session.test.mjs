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
for (const stage of ['readiness', 'launch', 'mismatch', 'existing', 'symlink']) {
  test('owned native session: ' + stage, async () => {
    const base = mkdtempSync(join(tmpdir(), 'native-failure-'));
    const socket = join(base, 'wayland'),
      server = createServer(),
      original = process.env.WAYLAND_DISPLAY;
    const oldRun = process.env.XDG_RUNTIME_DIR;
    await new Promise((resolve) => server.listen(socket, resolve));
    try {
      process.env.WAYLAND_DISPLAY = socket;
      process.env.XDG_RUNTIME_DIR = base;
      const installedRoot = join(base, 'installed');
      mkdirSync(installedRoot);
      const files = {
        'launch.js': `import fs from 'node:fs';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
        const profile=process.argv[process.argv.indexOf('--profile')+1];
        if(process.argv[2]==='init'){ fs.mkdirSync(profile);console.log(JSON.stringify({ok:true}));}
        else if(${JSON.stringify(stage)}==='readiness'){
          const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log(process.pid);setInterval(()=>{},1000)"]);
          child.stdout.once('data',b=>{fs.writeFileSync(profile+'/child',b);setTimeout(()=>process.exit(2),350);});
        } else {
          console.log(JSON.stringify({data:{profileId:createHash('sha256').update(profile).digest('hex'),instanceId:'qa',state:'ready'}}));
          setInterval(()=>{if(fs.existsSync(profile+'/stop'))process.exit(0);},20);
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
      const run = () =>
        openModelNativeSession({
          installedRoot,
          desktopExecutable: '/usr/bin/false',
          root,
          label: 'native',
        });
      if (stage === 'existing' || stage === 'symlink') {
        await assert.rejects(run, stage === 'existing' ? /EEXIST/ : /canonical/);
        assert.equal(existsSync(join(root, 'workspace')), false);
        return;
      }
      await assert.rejects(
        run,
        stage === 'readiness'
          ? /before readiness/
          : stage === 'mismatch'
            ? /wrong/
            : /Desktop exited/,
      );
      const ledger = JSON.parse(readFileSync(join(root, 'cleanup.json'), 'utf8'));
      assert.deepEqual(ledger.failures, []);
      assert.equal(existsSync(ledger.short), false);
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
      rmSync(base, { recursive: true });
    }
  });
}
