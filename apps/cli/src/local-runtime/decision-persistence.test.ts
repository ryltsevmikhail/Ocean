import {
  DecisionPersistenceError,
  RuntimeOwnerDecisions,
  type OwnerDecision,
} from '@runnets/application';
import { InMemoryOwnerDecisions } from '@runnets/store';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';

it.each(['cancelled', 'expired'])(
  'a %s decision CAS I/O failure retains the listening owner and its unresolved card',
  async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-decision-io-')),
      profile = join(root, 'profile'),
      runDir = join(root, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    try {
      const offline = openOceanProfile(profile, true);
      await offline.ready;
      const q = rooms(offline.conversations);
      try {
        await offline.chat.send({
          ...q,
          provider: {
            id: 'test',
            models: ['test'],
            capabilities: { usage: true, streaming: true, reasoning: false },
            async *stream() {
              yield { type: 'text_delta', text: 'partial' };
            },
          },
          signal: new AbortController().signal,
          emit: () => {},
        });
      } finally {
        offline.close();
      }
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
 import {DatabaseSync} from 'node:sqlite';
 import {startLocalRuntime} from './apps/cli/dist/local-runtime/host.js';
 import {openOceanProfile} from './apps/cli/dist/ocean/profile.js';
 import {connectLocalRuntime} from './packages/tools-node/dist/index.js';
 const [profile,roomId,outcome]=process.argv.slice(1),scope={workspaceId:'ws_ocean',roomId};
 let failures=0, uncaught=0,expire;process.on('uncaughtExceptionMonitor',()=>uncaught++);
 const original=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){
   const statement=original.call(this,sql);
   if(sql.startsWith('UPDATE ocean_owner_decisions SET status=?,version=version+1')){
      const run=statement.run.bind(statement);
      statement.run=(...args)=>{if(args[0]===outcome && failures++===0)throw Object.assign(Error('synthetic IOERR'),{code:'SQLITE_IOERR'});return run(...args);};
   }
   return statement;
 };
 let dispatches=0;const host=await startLocalRuntime({profile,provider:{id:'test',models:['test'],capabilities:{usage:true,streaming:true},async *stream(){dispatches++;throw Error('unexpected provider');}},drainDeadlineMs:200});
 const c=await connectLocalRuntime({profile}),review=await c.reviewRoom(scope);
 const schedule=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>{
   if(outcome==='expired'&&ms>295000&&ms<=300000){expire=()=>schedule(fn,0,...args);}
   return schedule(fn,ms,...args);
 };
 const card=await c.requestContinuation({...scope,runId:review.runId,requestId:'owner',reason:'inspected',reviewVersion:review.version});
 globalThis.setTimeout=schedule;
 const ref={...scope,runId:card.runId,decisionId:card.decisionId};
 let refusal=null;
 if(expire){expire();await new Promise(r=>schedule(r,20));
   try{await c.resolveDecision({...ref,choice:'allow-once',expectedVersion:1,bindingDigest:card.bindingDigest});}catch(e){refusal=e.message;}
 }
 const stop=await host.stop();await new Promise(r=>schedule(r,20));
 let ownerBusy=false;try{openOceanProfile(profile).close();}catch(e){ownerBusy=e.code==='owner_busy';}
 let cardStatus,applied,listener;
 try{cardStatus=(await c.getDecision(ref)).status;applied=await c.continuationApplied(ref);listener=(await c.status()).state;}catch(e){listener=e.message;}
 const db=new DatabaseSync(profile+'/runtime.sqlite',{readOnly:true});const writes=db.prepare('SELECT count(*) AS n FROM ocean_coding_approval_claims').get().n;const acknowledgements=db.prepare('SELECT count(*) AS n FROM ocean_reviews').get().n;db.close();
 console.log(JSON.stringify({dispatches,writes,acknowledgements,uncaught,failures,stop:stop.outcome,ownerBusy,cardStatus,applied,listener,refusal}));
 process.exit(0);
 `,
          profile,
          q.roomId,
          outcome,
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
            XDG_RUNTIME_DIR: runDir,
          },
          timeout: 5000,
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        dispatches: 0,
        writes: 0,
        acknowledgements: 0,
        uncaught: 0,
        failures: 1,
        stop: 'uncertain',
        ownerBusy: true,
        cardStatus: 'pending',
        applied: false,
        listener: 'stop_incomplete',
        refusal: outcome === 'expired' ? 'decision_persistence_failed' : null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('a failed abort write fences an in-flight allow and a fresh prompt for the same run', async () => {
  const owner = new RuntimeOwnerDecisions(new InMemoryOwnerDecisions(), () => 5);
  const abort = new AbortController(),
    card: OwnerDecision = {
      workspaceId: 'w',
      roomId: 'r',
      runId: 'run',
      decisionId: 'id',
      kind: 'write',
      createdAt: 5,
      expiresAt: 300005,
      previewLength: 5,
      version: 1,
      status: 'pending',
      bindingDigest: 'a'.repeat(64),
    };
  let release!: () => void,
    claims = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const wait = owner
    .open(card, 'exact', abort.signal, async () => {
      await gate;
      return true;
    })
    .then((result) => {
      if (result === 'allowed') claims++;
    });
  const waiting = expect(wait).rejects.toBeInstanceOf(DecisionPersistenceError);
  const allow = owner.resolve(card, card.bindingDigest, 1, 'allow-once');
  const voting = expect(allow).rejects.toBeInstanceOf(DecisionPersistenceError);
  const settle = owner.store.settle.bind(owner.store);
  owner.store.settle = () => {
    throw Object.assign(Error('I/O'), { code: 'SQLITE_IOERR' });
  };
  abort.abort();
  owner.store.settle = settle;
  release();
  await Promise.all([waiting, voting]);
  expect(claims).toBe(0);
  expect(owner.store.find(card)).toMatchObject({ status: 'pending', version: 1 });
  const second = new AbortController();
  try {
    expect(() =>
      owner.open({ ...card, decisionId: 'other' }, 'exact', second.signal, async () => true),
    ).toThrow(DecisionPersistenceError);
  } finally {
    second.abort();
  }
  await expect(owner.joinChecks()).rejects.toBeInstanceOf(DecisionPersistenceError);
});
