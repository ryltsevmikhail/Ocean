import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createRuntime } from '../runtime.js';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  codingRows,
  leaseRegistryRows,
  preparedFinalizationTask,
  worktreeBytesHash,
} from '../ocean/coding-finalization-fixture.js';
import type { CodingAccess } from '@runnets/domain';
const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const worker = String.raw`
import fs from 'node:fs';
import {join} from 'node:path';
const [repository,db,phase]=process.argv.slice(1);
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
const task=store.coding.atomic((tx)=>tx.task('task'));
const owner=new RuntimeOwnerDecisions(store.ownerDecisions,Date.now);
const leases=new SqliteProjectLeases();
const service=new CodingFinalizationService({
 store:store.finalization,
 leases,
 owner,
 clock:{now:()=>new Date()},
 ownerId:task.lease.ownerId,
 epochId:null,
 restored:false,
 nextId:()=>'decision-1',
 digest:(text)=>createHash('sha256').update(text).digest('hex'),
});
const selection={workspaceId:task.workspaceId,roomId:task.ownerRoomId,taskId:task.id,requestId:'finalize-crash'};
const card=await service.preview(selection,new AbortController().signal);
await owner.resolve({workspaceId:card.workspaceId,roomId:card.roomId,runId:card.runId,decisionId:card.decisionId},card.bindingDigest,card.version,'allow-once');
await service.join();
process.stdout.write('finished\n');
`;
function state(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT payload FROM ocean_coding_finalizations WHERE request_id='finalize-crash'")
      .get();
    const task = db.prepare("SELECT status FROM ocean_coding_tasks WHERE id='task'").get();
    return {
      state: row ? (JSON.parse(String(row['payload'])) as { state: string }).state : null,
      task: task ? String(task['status']) : null,
    };
  } finally {
    db.close();
  }
}
it.each(['intent', 'registry_begin', 'registry_commit', 'result'])(
  'kills a real finalization at %s and two reopenings never retry an unknown release',
  async (phase) => {
    const f = await preparedFinalizationTask();
    const tree = worktreeBytesHash(f.worktree);
    const evidence = codingRows(f.db, 'task');
    try {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', worker, repository, f.db, phase],
        {
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
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
      const after = state(f.db);
      const beforeReopen = leaseRegistryRows(f.registryPath);
      if (phase === 'intent' || phase === 'registry_begin') {
        expect(after).toEqual({ state: 'finalizing', task: 'finalizing' });
        expect(beforeReopen.leases).toHaveLength(2);
        expect(beforeReopen.receipts).toHaveLength(0);
      } else if (phase === 'registry_commit') {
        expect(after).toEqual({ state: 'finalizing', task: 'finalizing' });
        expect(beforeReopen.leases).toHaveLength(1);
        expect(beforeReopen.receipts).toHaveLength(1);
      } else {
        expect(after).toEqual({ state: 'finalized', task: 'finalized' });
        expect(beforeReopen.leases).toHaveLength(1);
        expect(beforeReopen.receipts).toHaveLength(1);
      }
      for (let reopen = 0; reopen < 2; reopen++) {
        const runtime = createRuntime({ dbPath: f.db, codingWorktreeDirectory: f.worktreeBase });
        try {
          await runtime.ready;
          const access: CodingAccess = {
            workspaceId: 'ws_ocean',
            taskId: 'task',
            roomId: f.room,
            botId: f.task.devBotId,
            policyVersion: 1,
            capability: 'project_read',
          };
          expect(runtime.coding.authorize(access)).toMatchObject({
            ok: false,
            error: { code: 'coding_denied' },
          });
        } finally {
          runtime.close();
        }
        const registryNow = leaseRegistryRows(f.registryPath);
        expect(registryNow.receipts).toHaveLength(beforeReopen.receipts.length);
        expect(registryNow.leases).toHaveLength(
          phase === 'registry_commit' || phase === 'result' ? 1 : beforeReopen.leases.length,
        );
        if (phase === 'intent' || phase === 'registry_begin') {
          expect(state(f.db)).toEqual({ state: 'uncertain', task: 'finalizing' });
        } else if (phase === 'registry_commit') {
          const resolved = state(f.db);
          expect(resolved.task).toBe('finalized');
          expect(resolved.state).toBe('finalized');
        } else {
          expect(state(f.db)).toEqual({ state: 'finalized', task: 'finalized' });
        }
      }
      if (phase === 'intent' || phase === 'registry_begin') {
        // The public result path decodes the held record without retrying anything.
        const host = await startLocalRuntime({
          profile: f.profile,
          provider: null,
          codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
        });
        const client = await connectLocalRuntime({ profile: f.profile });
        try {
          const result = await client.finalizationResult({
            workspaceId: 'ws_ocean',
            roomId: f.room,
            taskId: 'task',
            requestId: 'finalize-crash',
          });
          expect(result).toMatchObject({
            state: 'uncertain',
            taskStatus: 'finalizing',
            release: { state: 'unproven', outcome: null, receipt: null },
          });
        } finally {
          client.close();
          await host.stop();
        }
      }
      expect(worktreeBytesHash(f.worktree)).toBe(tree);
      expect(codingRows(f.db, 'task').changesets).toEqual(evidence.changesets);
      expect(codingRows(f.db, 'task').reviews).toEqual(evidence.reviews);
      expect(codingRows(f.db, 'task').evidence).toEqual(evidence.evidence);
    } finally {
      f.close();
    }
  },
  60000,
);
