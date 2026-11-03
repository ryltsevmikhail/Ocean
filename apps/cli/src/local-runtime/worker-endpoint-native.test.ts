import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses a worker-visible /usr endpoint before service and isolates normal XDG and fallback endpoints',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-worker-endpoint-'));
    for (const name of ['usr-local', 'work', 'run']) mkdirSync(join(root, name), { mode: 0o700 });
    writeFileSync(join(root, 'work/.git'), 'fixture');
    const program = `
      import {execFile} from 'node:child_process';import {promisify} from 'node:util';
      import {openOceanProfile} from ${JSON.stringify('/app/apps/cli/dist/ocean/profile.js')};
      import {startLocalRuntime} from ${JSON.stringify('/app/apps/cli/dist/local-runtime/host.js')};
      import {localRuntimePaths} from ${JSON.stringify('/app/packages/tools-node/dist/index.js')};
      import {sandboxArgv} from ${JSON.stringify('/app/packages/tools-node/dist/sandbox-layout.js')};
      const results=[];
      for(const mode of ['system','xdg','fallback']) {
        const profile='/profiles/'+mode;
        const rt=openOceanProfile(profile,true);await rt.ready;rt.close();
        if(mode==='system')process.env.XDG_RUNTIME_DIR='/usr/local';
        else if(mode==='xdg')process.env.XDG_RUNTIME_DIR='/run';
        else delete process.env.XDG_RUNTIME_DIR;
        let host, refusal=null, paths;
        try { paths=localRuntimePaths(profile);host=await startLocalRuntime({profile,provider:null}); }
        catch(e){refusal=e.message;}
        let exposed=false;
        if(host){
          const script='const fs=require("fs"),net=require("net");let d;try{d=JSON.parse(fs.readFileSync('+JSON.stringify(paths.descriptor)+',"utf8"));}catch{};'
            +'if(!d){console.log("private");}else{const c=net.connect(d.endpoint);c.on("error",()=>console.log("private"));c.on("connect",()=>c.write(JSON.stringify({id:"h",method:"hello",params:{protocol:1,profileId:d.profileId,instanceId:d.instanceId,capability:d.capability}})+"\\\\n"));c.on("data",b=>{console.log(String(b).includes("decisions.resolve")?"exposed":"invalid");c.destroy();});}';
          exposed=(await promisify(execFile)('/usr/bin/bwrap',sandboxArgv('/work',script),{encoding:'utf8',timeout:5000})).stdout.trim()==='exposed';
          await host.stop();await host.closed;
        }
        results.push({mode,refusal,served:!!host,exposed});
      }
      console.log(JSON.stringify(results));
    `;
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
          `cd "$1"; mkdir -p usr/bin usr/lib usr/local proc app dev profiles tmp etc old; mount --bind . .; cd "$1"; printf 'root:x:0:0:root:/:/usr/bin/sh\n' > etc/passwd; chmod 700 usr/local; touch node dev/null; ln -s usr/lib lib; ln -s usr/lib lib64; mount --bind /usr/bin usr/bin; mount --bind /usr/lib usr/lib; mount --rbind /proc proc; mount --rbind /dev dev; mount --bind "$2" node; mount --bind "$3" app; pivot_root . old; umount -l /old; exec /node --input-type=module -e "$4"`,
          'fixture',
          root,
          process.execPath,
          resolve('.'),
          program,
        ],
        { env: { PATH: process.env['PATH'], HOME: root }, timeout: 15000 },
      );
      expect(JSON.parse(stdout)).toEqual([
        { mode: 'system', refusal: 'worker_visible_endpoint', served: false, exposed: false },
        { mode: 'xdg', refusal: null, served: true, exposed: false },
        { mode: 'fallback', refusal: null, served: true, exposed: false },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
