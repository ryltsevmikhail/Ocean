import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';

it.each(['unregistered', 'unexpected'])(
  'distinguishes %s coding startup before reporting the owner drain',
  async (phase) => {
    const f = await codingWorkflowFixture('direct'),
      run = join(f.directory, 'run');
    try {
      f.runtime.close();
      chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      mkdirSync(run, { mode: 0o700 });
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
 import {openSqliteStore} from './packages/store-sqlite/dist/index.js';
 import {startLocalRuntime} from './apps/cli/dist/local-runtime/host.js';
 import {connectLocalRuntime} from './packages/tools-node/dist/index.js';
 const [profile,roomId,phase]=process.argv.slice(1);
 let calls=0;const provider={id:'fixture',models:['fixture'],capabilities:{usage:true,streaming:true},async *stream(){calls++;throw Error('denied before dispatch');}};
 const host=await startLocalRuntime({profile,provider,...(phase==='unexpected'?{codingTools:{sandbox:async()=>{
   const db=openSqliteStore({path:profile+'/runtime.sqlite'});try{
   const t=db.conversations.atomic(tx=>tx.activeChatTurn(roomId));
   await db.tools.claim('probe','qualification',{taskRunId:t.taskRunId,attemptId:'probe'},'synthetic');}
   finally{db.close();}throw Error('unproven cleanup');
 }}}:{})});
 const c=await connectLocalRuntime({profile}),scope={workspaceId:'ws_ocean',roomId};
 const q={...scope,taskId:'task',requestId:'refused',text:'try task'};
 const receipt=await c.submit(q);
 let turn;
 for(let i=0;i<100;i++){turn=await c.getRun({...scope,runId:receipt.runId});if(['failed','uncertain'].includes(turn.turnStatus))break;await new Promise(r=>setTimeout(r,10));}
 const same=await c.submit(q); const stop=await host.stop();c.close();
 const db=openSqliteStore({path:profile+'/runtime.sqlite'});const held=db.tools.inspectPending().length;db.close();
 console.log(JSON.stringify({held,calls,turn:turn.turnStatus,same:receipt.runId===same.runId,outcome:stop.outcome}));
 process.exit(0);
 `,
          f.directory,
          f.room,
          phase,
        ],
        { env: { PATH: process.env['PATH'], XDG_RUNTIME_DIR: run }, timeout: 5000 },
      );
      expect(JSON.parse(stdout)).toEqual({
        held: phase === 'unexpected' ? 1 : 0,
        calls: 0,
        turn: phase === 'unregistered' ? 'failed' : 'uncertain',
        same: true,
        outcome: phase === 'unregistered' ? 'complete' : 'uncertain',
      });
    } finally {
      f.close();
    }
  },
);
