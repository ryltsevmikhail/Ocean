import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { startLocalRuntime } from './host.js';
const exec = promisify(execFile);
it('an independent owner client observes the durable original receipt after a lost reply and owner restart', async () => {
  const f = await privateRoot();
  let host = await startLocalRuntime({ profile: f.profile, provider: null });
  const helper = new URL('../../test-fixtures/service-owner-peer.ts', import.meta.url).href;
  const client = async (action: string) => {
    const script = `import {serviceOwnerPeer} from ${JSON.stringify(helper)};
      const p=await serviceOwnerPeer(process.argv[1]);
      const input={requestId:'detached',connectionId:'owned',expectedVersions:null,name:'Before',configuration:{kind:'http',url:'http://127.0.0.1:1/mcp'},metadataPermission:'none'};
      if(process.argv[2]==='detach') {p.request('service.connection-set',input); await new Promise(r=>setTimeout(r,25)); p.close();}
      else {const original=await p.request('service.connection-set',input);const current=await p.request('service.connections',{});p.close();console.log(JSON.stringify({original,current}));}`;
    return exec(process.execPath, ['--input-type=module', '-e', script, f.profile, action], {
      timeout: 10000,
    });
  };
  try {
    await client('detach');
    const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM ocean_service_owner_receipts').get()?.['n']).toBe(
      1,
    );
    db.close();
    expect(await host.stop()).toMatchObject({ outcome: 'complete' });
    host = await startLocalRuntime({ profile: f.profile, provider: null });
    const result = JSON.parse((await client('read')).stdout) as {
      original: { state: string; result: { name: string } };
      current: unknown[];
    };
    expect(result.original).toMatchObject({
      state: 'completed',
      result: { name: 'Before', configRevision: 1 },
    });
    expect(result.current).toHaveLength(1);
    console.log(
      JSON.stringify({
        scenario: 'owner-receipt-restart',
        receipts: 1,
        connections: 1,
        replayed: true,
      }),
    );
  } finally {
    await host.stop();
    f.dispose();
  }
}, 20000);
