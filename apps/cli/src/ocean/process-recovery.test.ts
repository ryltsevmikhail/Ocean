import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from '../local-runtime/host.js';
import { openOceanProfile } from './profile.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const root =
  process.env['OCEAN_RC_INSTALL'] ??
  resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
// This child deliberately blocks only after signalling a committed boundary. Parent kills it.
const worker = String.raw`
import {registerHooks} from 'node:module';
import {existsSync,appendFileSync,writeFileSync,writeSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const [root,path,roomId,phase]=process.argv.slice(1);
const aliases={application:'application',domain:'domain',store:'store','store-sqlite':'store-sqlite'};
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@runnets/')){
  const name=aliases[specifier.slice(9)];
  if(name) {
   const built=join(root,'node_modules/@runnets',name,'dist/index.js');
   return next(pathToFileURL(existsSync(built)?built:join(root,'packages',name,'src/index.ts')).href,context);
  }
 }
 if(specifier.endsWith('.js')&&context.parentURL?.startsWith(pathToFileURL(root).href)){
  const url=new URL(specifier,context.parentURL);url.pathname=url.pathname.slice(0,-3)+'.ts';
  if(existsSync(fileURLToPath(url)))return next(url.href,context);
 }
 return next(specifier,context);
}});
const {ConversationService,DirectChatService,TaskRunService}=await import('@runnets/application');
const {openSqliteStore,ownSqliteRuntime}=await import('@runnets/store-sqlite');
const halt=name=>{writeSync(1,name+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const release=ownSqliteRuntime(path);const db=openSqliteStore({path});
const clock={now:()=>new Date('2026-11-02T00:00:00Z')};
const ids={eventId:()=> 'ev_'+randomUUID().replaceAll('-',''),commandId:()=> 'cm_'+randomUUID().replaceAll('-','')};
const tasks=new TaskRunService({log:db.log,clock,ids});
const execute=tasks.execute.bind(tasks);
tasks.execute=command=>{if(command.type==='Complete'&&phase==='prepared')halt('prepared');return execute(command);};
const store={atomic:work=>db.conversations.atomic(tx=>work({...tx,putMessage(message){
 if(message.author==='bot'&&phase==='publication')halt('publication');
 tx.putMessage(message);
}}))};
const chat=new DirectChatService({store,tasks,clock,nextId:()=>randomUUID().replaceAll('-','')});
const provider={id:'test',models:['test'],capabilities:{streaming:true,usage:true,reasoning:false},
 async *stream(){
  appendFileSync(path+'.calls','dispatch\n');
  if(phase==='dispatch')halt('dispatch');
  if(phase==='before_claim')halt('before_claim');
  if(phase==='after_claim'){
   const turn=db.conversations.atomic(tx=>tx.chatTurns().at(-1));
   const claimed = await db.tools.claim('rc-claim','test',{taskRunId:turn.taskRunId,attemptId:'rc-attempt'},'synthetic');
   if (claimed) appendFileSync(path+'.effects','effect\n',{flush:true});
   halt('after_claim');
  }
  yield {type:'text_delta',text:'Recovered answer '.repeat(300)};
  yield {type:'usage',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
  yield {type:'completed',stopReason:'stop',rawStopReason:'stop'};
 }};
try{
 const input={workspaceId:'ws_ocean',roomId,requestId:'killed-turn',text:'Synthetic prompt',provider,
  signal:new AbortController().signal,emit:()=>{},};
 if(phase==='accepted'||phase==='after_claim'){
   const result=chat.submit(input);
   if(!result.ok)throw Error('submit failed');
   writeFileSync(path+'.receipt',JSON.stringify(result.value.receipt),{flush:true});
   if(phase==='accepted')halt('accepted');
   await result.value.completion;
 }else await chat.send(input);
}finally{db.close();release();}
`;

async function killAt(path: string, roomId: string, phase: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', worker, root, path, roomId, phase],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] } },
  );
  let error = '';
  child.stderr.on('data', (b: Buffer) => {
    error += b.toString();
  });
  const stopped = new Promise<void>((r, j) => {
    child.once('error', j);
    child.once('close', () => r());
  });
  try {
    await new Promise<void>((r, j) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        j(new Error('Fault boundary timeout: ' + error));
      }, 10000);
      child.stdout.once('data', (b: Buffer) => {
        clearTimeout(timeout);
        if (b.toString().trim() !== phase) j(new Error('Unexpected fault boundary'));
        else r();
      });
      child.once('close', () => {
        clearTimeout(timeout);
        j(new Error('Worker exited before boundary: ' + error));
      });
      child.once('error', j);
    });
    child.kill('SIGKILL');
    await stopped;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopped;
  }
}
for (const phase of [
  'accepted',
  'dispatch',
  'before_claim',
  'after_claim',
  'prepared',
  'publication',
]) {
  it(
    'recovers a real process killed at ' + phase + ' without another external dispatch',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ocean-kill-'));
      folders.push(dir);
      const path = join(dir, 'runtime.sqlite');
      let runtime = openOceanProfile(dir, true);
      let roomId = '';
      try {
        await runtime.ready;
        runtime.conversations.execute({
          type: 'BindWorkspace',
          requestId: 'init',
          workspaceId: 'ws_ocean',
          root: dir,
        });
        const b = runtime.conversations.execute({
          type: 'CreateBot',
          requestId: 'bot',
          workspaceId: 'ws_ocean',
          handle: 'dev',
          name: 'Dev',
          role: 'Role',
          provider: 'test',
          model: 'test',
        });
        if (!b.ok || b.value.kind !== 'bot') throw Error('bot');
        const r = runtime.conversations.execute({
          type: 'OpenDirectRoom',
          requestId: 'room',
          workspaceId: 'ws_ocean',
          botId: b.value.data.id,
        });
        if (!r.ok || r.value.kind !== 'room') throw Error('room');
        roomId = r.value.data.id;
      } finally {
        runtime.close();
      }
      await killAt(path, roomId, phase);
      const before = existsSync(path + '.calls') ? readFileSync(path + '.calls', 'utf8') : '';
      if (phase === 'accepted' || phase === 'after_claim') {
        const receipt = JSON.parse(readFileSync(path + '.receipt', 'utf8'));
        for (let reopen = 0; reopen < 2; reopen++) {
          // The killed application owner had no listener. Both subsequent socket hosts shut down cleanly.
          const owner = await startLocalRuntime({ profile: dir, provider: null });
          const a = await connectLocalRuntime({ profile: dir });
          const b = await connectLocalRuntime({ profile: dir });
          try {
            const scope = { workspaceId: 'ws_ocean', roomId, requestId: 'killed-turn' };
            expect(await a.getReceipt(scope)).toEqual(receipt);
            expect(await b.submit({ ...scope, text: 'Synthetic prompt' })).toEqual(receipt);
            const query = { workspaceId: 'ws_ocean', roomId, runId: receipt.runId };
            const snapshot = await a.getRun(query);
            expect(snapshot).toMatchObject(
              phase === 'accepted'
                ? { turnStatus: 'failed', taskStatus: 'not_created', version: 0 }
                : { turnStatus: 'uncertain', taskStatus: 'reconciling' },
            );
            expect(await b.getRun(query)).toEqual(snapshot);
            expect(await b.observeRun(query)).toMatchObject({ kind: 'snapshot', snapshot });
            await expect(
              a.cancelRun({
                ...query,
                requestId: 'recovered-cancel',
                expectedVersion: snapshot!.version,
              }),
            ).rejects.toThrow('run_not_active');
            expect(await a.getRun(query)).toEqual(snapshot);
            expect(
              existsSync(path + '.effects') ? readFileSync(path + '.effects', 'utf8') : '',
            ).toBe(phase === 'after_claim' ? 'effect\n' : '');
          } finally {
            a.close();
            b.close();
            expect((await owner.stop()).outcome).toBe('complete');
            await owner.closed;
          }
        }
      }
      runtime = openOceanProfile(dir);
      try {
        await runtime.ready;
        const history = runtime.conversations.history('ws_ocean', roomId);
        if (!history.ok) throw Error('history');
        if (phase === 'prepared' || phase === 'publication') {
          expect(history.value.map((m) => m.author)).toEqual(['user', 'bot']);
          expect(history.value[1]?.body).toBe('Recovered answer '.repeat(300));
        } else {
          expect(history.value.map((m) => m.author)).toEqual(['user']);
          if (['dispatch', 'before_claim', 'after_claim'].includes(phase)) {
            const reviewed = await runtime.reviews.reviewRoom('ws_ocean', roomId);
            expect(reviewed).toMatchObject({
              ok: true,
              value: { turnStatus: 'uncertain', canAcknowledge: true },
            });
          }
        }
        expect((await runtime.toolJournal!.pending()).map((effect) => effect.outcome)).toEqual(
          phase === 'after_claim' ? ['uncertain'] : [],
        );
        expect(existsSync(path + '.calls') ? readFileSync(path + '.calls', 'utf8') : '').toBe(
          before,
        );
        expect(before).toBe(phase === 'accepted' ? '' : 'dispatch\n');
      } finally {
        runtime.close();
      }
    },
    20000,
  );
}
