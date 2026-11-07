/** Shared fixtures retain the existing owner, provider gate, crash claim and real client. */
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import { acceptanceOwner } from './acceptance-owner.test.js';
import { decisionPeer } from './decision-peer.test.js';
import { detachedClient } from './detached-client.test.js';
import { rooms } from './local-runtime-admission.test.js';
// eslint-disable-next-line no-restricted-imports -- Same-app fixture seeds the private CLI profile.
import { openOceanProfile } from '../src/ocean/profile.js';

export async function ownEngineFixture(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'ocean-own-'));
  const profile = join(root, 'profile'),
    run = join(root, 'run'),
    path = join(root, 'empty-bin');
  mkdirSync(run, { mode: 0o700 });
  mkdirSync(path, { mode: 0o700 });
  expect(isAbsolute(process.execPath)).toBe(true);
  expect(readdirSync(path)).toEqual([]);
  for (const command of ['codex', 'claude']) {
    const probe = spawnSync(command, ['--version'], { env: { PATH: path } });
    expect((probe.error as NodeJS.ErrnoException)?.code).toBe('ENOENT');
  }
  const offline = openOceanProfile(profile, true);
  await offline.ready;
  const { groupId, ...request } = rooms(offline.conversations);
  offline.close();
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  const owners: ReturnType<typeof acceptanceOwner>[] = [];
  const launch = (mode: string) => {
    const owner = acceptanceOwner(profile, run, mode, path);
    owners.push(owner);
    return owner;
  };
  const env = { PATH: path, XDG_RUNTIME_DIR: run };
  const owner = launch(scenario);
  return {
    profile,
    request,
    groupId,
    db,
    owner,
    launch,
    scope: { workspaceId: request.workspaceId, roomId: request.roomId },
    peer: decisionPeer(profile, run, path),
    client: detachedClient({ profile, request, env }),
    legacy: async <T = unknown>(method: string, params: unknown): Promise<T> => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', legacyProgram, profile, method, JSON.stringify(params)],
        { env },
      );
      return JSON.parse(stdout) as T;
    },
    async close() {
      for (const child of owners) await child.kill();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Frozen RC2 validation and old hello shape run in an independent Node process. */
const legacyProgram = `
import {connect} from 'node:net';
import {readLocalRuntimeDescriptor} from './packages/tools-node/dist/index.js';
import {isLocalRuntimeIdentity} from './apps/cli/test-fixtures/rc2-runtime-contract.ts';
const d=readLocalRuntimeDescriptor(process.argv[1]);
const socket=connect(d.endpoint);
let pending='', phase='hello';
socket.setTimeout(4000,()=>socket.destroy(Error('legacy timeout')));
socket.on('error',e=>{console.error(e.message);process.exitCode=1;});
const send=(id,method,params)=>socket.write(JSON.stringify({id,method,params})+'\\n');
socket.on('data',bytes=>{
  pending+=bytes.toString();
  let end;
  while((end=pending.indexOf('\\n'))>=0){
    const reply=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
    if(phase==='hello'){
      if(!isLocalRuntimeIdentity(reply.result)){
        console.error('RC2 identity refused');process.exitCode=1;socket.destroy();return;
      }
      phase='request';send('request',process.argv[2],JSON.parse(process.argv[3]));
    }else{
      if(process.argv[2]==='status'&&!isLocalRuntimeIdentity(reply.result)){
        console.error('RC2 status refused');process.exitCode=1;socket.destroy();return;
      }
      console.log(JSON.stringify(reply));socket.end();
    }
  }
});
// No endpoint field and no clientFeatures: the pre-negotiation RC2 hello.
send('hello','hello',{protocol:1,profileId:d.profileId,instanceId:d.instanceId,capability:d.capability});
`;
