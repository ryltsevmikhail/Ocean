// Real finalization worker; halts at a named durable boundary for the parent SIGKILL.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
export const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const finalizationCrashWorker = String.raw`
import fs from 'node:fs';
import {join} from 'node:path';
const [repository,db,phase,targetTask='task',requestId='finalize-crash']=process.argv.slice(1);
const registry=join(process.env.HOME,'.local/state/ocean-coordination/leases.sqlite');
let sawDisable=false,sawResult=false,halted=false;
const halt=(name)=>{if(halted)return;halted=true;fs.writeSync(1,name+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const {DatabaseSync}=await import('node:sqlite');
const originalPrepare=DatabaseSync.prototype.prepare;
const originalExec=DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare=function(sql){
 const stmt=originalPrepare.call(this,sql);
 if(String(sql).includes('ocean_coding_finalizations')){
  const run=stmt.run.bind(stmt);
  stmt.run=(...args)=>{
   if(args.some((a)=>typeof a==='string'&&a.includes('"state":"finalizing"')))sawDisable=true;
   if(args.some((a)=>typeof a==='string'&&a.includes('"state":"finalized"')))sawResult=true;
   return run(...args);
  };
 }
 return stmt;
};
DatabaseSync.prototype.exec=function(sql){
 const db=this,r=originalExec.call(this,sql),loc=String(db.location()),text=String(sql).trim().toUpperCase();
 if(loc===dbPathOf&&text.startsWith('COMMIT')){
  if(phase==='intent'&&sawDisable)halt('intent');
  if(phase==='result'&&sawResult)halt('result');
 }
 if(loc===registry){
  if(text.startsWith('BEGIN IMMEDIATE')&&phase==='registry_begin')halt('registry_begin');
  if(text.startsWith('COMMIT')&&phase==='registry_commit')halt('registry_commit');
 }
 return r;
};
const dbPathOf=db;
const {pathToFileURL}=await import('node:url');
const dist=(path)=>pathToFileURL(join(repository,path)).href;
const {openSqliteStore}=await import(dist('packages/store-sqlite/dist/index.js'));
const {CodingFinalizationService,RuntimeOwnerDecisions}=await import(dist('packages/application/dist/index.js'));
const {SqliteProjectLeases}=await import(dist('packages/tools-node/dist/index.js'));
const {createHash}=await import('node:crypto');
const store=openSqliteStore({path:db});
const task=store.coding.atomic((tx)=>tx.task(targetTask));
const owner=new RuntimeOwnerDecisions(store.ownerDecisions,Date.now);
const leases=new SqliteProjectLeases();
// The fixture needs an exact interrupted state, so the worker suppresses the
// service constructor's startup recovery. The parent reopens with real recovery.
const finalizationStore={...store.finalization,recover:()=>{},unresolvedFinalizing:()=>[]};
const service=new CodingFinalizationService({
 store:finalizationStore,
 leases,
 owner,
 clock:{now:()=>new Date()},
 ownerId:task.lease.ownerId,
 epochId:null,
 restored:false,
 nextId:()=>requestId+'-decision',
 digest:(text)=>createHash('sha256').update(text).digest('hex'),
});
const selection={workspaceId:task.workspaceId,roomId:task.ownerRoomId,taskId:task.id,requestId};
const card=await service.preview(selection,new AbortController().signal);
if(phase==='preview')halt('preview');
await owner.resolve({workspaceId:card.workspaceId,roomId:card.roomId,runId:card.runId,decisionId:card.decisionId},card.bindingDigest,card.version,'allow-once');
await service.join();
process.stdout.write('finished\n');
`;
/** Spawn the real service, wait for the named boundary, then SIGKILL it. */
export async function crashFinalization(
  db: string,
  phase: string,
  target: { taskId?: string; requestId?: string } = {},
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      finalizationCrashWorker,
      repositoryRoot,
      db,
      phase,
      target.taskId ?? 'task',
      target.requestId ?? 'finalize-crash',
    ],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  const closed = once(child, 'close');
  try {
    const line = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data).trim()),
      closed.then(() => {
        throw Error('worker exited: ' + errors);
      }),
    ]);
    expect(line).toBe(phase);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  expect(child.signalCode).toBe('SIGKILL');
}
