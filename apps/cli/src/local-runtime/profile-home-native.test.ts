import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'uses explicit profiles without HOME or passwd and keeps offline ownership checks',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-no-home-'));
    try {
      const { stdout } = await promisify(execFile)(
        '/usr/bin/unshare',
        [
          '--map-root-user',
          '--map-auto',
          '--mount',
          '--propagation',
          'private',
          'sh',
          '-eu',
          '-c',
          `cd "$1"; mkdir usr proc app dev run home; chmod 700 run home; touch node dev/null;
        ln -s usr/lib lib; ln -s usr/lib lib64; mount --bind /usr usr; mount --rbind /proc proc;
        mount --bind /dev/null dev/null; mount --bind "$2" node; mount --bind "$3" app;
        chroot . /node --input-type=module -e "$4"`,
          'fixture',
          root,
          process.execPath,
          resolve('.'),
          `
        import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {once} from 'node:events';
        import {openOceanProfile} from '/app/apps/cli/dist/ocean/profile.js';
        process.env.HOME='/home';const rt=openOceanProfile('/profile',true);await rt.ready;rt.close();
        const env={PATH:'/usr/bin',XDG_RUNTIME_DIR:'/run'};
        const cli=async args=>{try{return {code:0,...await promisify(execFile)('/node',['/app/apps/cli/dist/main.js',...args],{env})};}catch(e){return e;}};
        const status=await cli(['runtime','status','--profile','/profile','--json']);
        console.log(JSON.stringify({status:status.code,reply:JSON.parse(status.stdout)}));
        const owner=spawn('/node',['/app/apps/cli/dist/main.js','runtime','start','--profile','/profile','--json'],{env,stdio:'pipe'});
        const exit=once(owner,'close');let out='';owner.stdout.on('data',b=>out+=b);
        while(!out.includes('\\n')&&owner.exitCode===null) await new Promise(r=>setTimeout(r,10));
        console.log(JSON.stringify({started:JSON.parse(out).data?.state??JSON.parse(out).error?.code}));
        if(out.includes('"state":"ready"')) {
          const acp=spawn('/node',['/app/apps/cli/dist/main.js','acp'],{env:{ ...Object.fromEntries(['HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR'].map(key => [key, process.env[key]])),...env,RUNNE_DB:'/profile/runtime.sqlite'},stdio:'pipe'});
          const acpExit=once(acp,'close');let err='';acp.stderr.on('data',b=>err+=b);acp.stdin.end();
          console.log(JSON.stringify({acp:(await acpExit)[0],error:err.trim()}));
          await cli(['runtime','stop','--profile','/profile','--json']);
        }
        await exit;
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
          timeout: 10000,
        },
      );
      const lines = stdout
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      expect(lines).toMatchObject([
        { status: 3, reply: { version: 1, ok: false, error: { code: 'runtime_absent' } } },
        { started: 'ready' },
        { acp: 3, error: 'owner_busy' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
