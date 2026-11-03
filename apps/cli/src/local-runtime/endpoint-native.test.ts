import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'preserves a foreign-UID descriptor and a same-inode bind mount in a private namespace',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-mount-'));
    try {
      const { stdout } = await promisify(execFile)(
        'unshare',
        [
          '--map-root-user',
          '--map-auto',
          '--mount',
          '--propagation',
          'private',
          'sh',
          '-eu',
          '-c',
          `
        cd "$1"
        mkdir usr proc app lib64 dev run etc
        printf 'root:x:0:0:root:/:/usr/bin/sh\n' > etc/passwd
        chmod 700 run
        ln -s usr/lib lib
        touch node dev/null
        mount --bind /usr usr
        mount --bind /lib64 lib64
        mount --rbind /proc proc
        mount --bind /dev/null dev/null
        mount --bind "$2" node
        mount --bind "$3" app
        chroot . /node --input-type=module -e "$4"
      `,
          'fixture',
          root,
          process.execPath,
          process.cwd(),
          `
        import {execFileSync,spawn} from 'node:child_process';
        import * as fs from 'node:fs';import {once} from 'node:events';import assert from 'node:assert/strict';
        import {openOceanProfile} from '/app/apps/cli/dist/ocean/profile.js';
        import {startLocalRuntime} from '/app/apps/cli/dist/local-runtime/host.js';
        import {localRuntimePaths} from '/app/packages/tools-node/dist/index.js';
        process.env.XDG_RUNTIME_DIR='/run';
        process.env.XDG_STATE_HOME='/state';
        for(const mode of ['mount','uid']){
          const profile='/'+mode;
          const rt=openOceanProfile(profile,true);await rt.ready;rt.close();
          const {descriptor,endpoint}=localRuntimePaths(profile);
          const owner=spawn('/node',['/app/apps/cli/dist/main.js','runtime','start','--profile',profile,'--json']);
          const exit=once(owner,'close');
          try {assert.match(String((await once(owner.stdout,'data'))[0]),/ready/);}
          finally {owner.kill('SIGKILL');await exit;}
          const before=fs.lstatSync(descriptor).ino;
          if(mode==='mount') execFileSync('/usr/bin/mount',['--bind',descriptor,descriptor]);
          else fs.chownSync(descriptor,1,1);
          await assert.rejects(startLocalRuntime({profile,provider:null}),/endpoint_changed/);
          assert.equal(fs.lstatSync(descriptor).ino,before);
          assert.ok(fs.lstatSync(endpoint).isSocket());
          if(mode==='mount') execFileSync('/usr/bin/umount',[descriptor]);
          else assert.equal(fs.lstatSync(descriptor).uid,1);
          console.log(mode+' refused');
        }
      `,
        ],
        {
          env: {
            ...Object.fromEntries(
              [
                'HOME',
                'XDG_RUNTIME_DIR',
                'XDG_CONFIG_HOME',
                'XDG_DATA_HOME',
                'XDG_STATE_HOME',
                'XDG_CACHE_HOME',
                'TMPDIR',
              ].map((key) => [key, process.env[key]]),
            ),
            PATH: process.env['PATH'],
          },
          timeout: 15000,
        },
      );
      expect(stdout).toBe('mount refused\nuid refused\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
