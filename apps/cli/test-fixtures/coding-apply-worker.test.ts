import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodingFileChange } from '@runnets/domain';
const repository =
  process.env['OCEAN_RC_INSTALL'] ?? resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const worker = String.raw`
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const [root,path,project,phase,seedJson]=process.argv.slice(1);
const halt=()=>{fs.writeSync(1,phase+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const rename=fs.renameSync;
fs.renameSync=(from,to)=>{rename(from,to);if(phase==='rename'&&String(to).endsWith('.before'))halt();};
const link=fs.linkSync;
fs.linkSync=(from,to)=>{link(from,to);if(phase==='published'&&String(from).endsWith('.after'))halt();};
const unlink=fs.unlinkSync;
fs.unlinkSync=from=>{unlink(from);if(phase==='unlinked'&&String(from).endsWith('.after'))halt();};
const fsync=fs.fsyncSync;
fs.fsyncSync=fd=>{fsync(fd);if(phase==='scope_header'&&fs.readlinkSync('/proc/self/fd/'+fd).endsWith('/scope.json'))halt();};
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@runnets/')) {
  const name=specifier.slice(9);
  const built=join(root,'node_modules/@runnets',name,'dist/index.js');
  const source=join(root,'packages',name,'src/index.ts');
  if(fs.existsSync(built)||fs.existsSync(source))return next(pathToFileURL(fs.existsSync(built)?built:source).href,context);
 }
 if(specifier.endsWith('.js')&&context.parentURL?.startsWith(pathToFileURL(root).href)) {
  const url=new URL(specifier,context.parentURL);url.pathname=url.pathname.slice(0,-3)+'.ts';
  if(fs.existsSync(fileURLToPath(url)))return next(url.href,context);
 }
 return next(specifier,context);
}});
const {openSqliteStore,ownSqliteRuntime}=await import('@runnets/store-sqlite');
const {GitCodingApplyProject}=await import('@runnets/tools-node');
const release=ownSqliteRuntime(path), store=openSqliteStore({path});
const content=text=>({text,mode:'100644',sha256:createHash('sha256').update(text).digest('hex')});
const seed=seedJson ? JSON.parse(seedJson) : {ownerId:'fixture',changesetHash:'a'.repeat(64),base:'base',changes:['a','b','c'].map(path=>({path,before:content('old-'+path),after:content('new-'+path)}))};
let receipt={recoveryProtocol:2,id:'apply',taskId:'task',changesetHash:seed.changesetHash,reviewRequestId:'review',expectedBase:seed.base,status:'applying',files:seed.changes.map(({path})=>({path,status:'pending'}))};
store.codingApplications.atomic(tx=>{if(!tx.claimApplication(receipt))throw Error('fixture claim refused');});
if(phase==='intent')halt();
const adapter=new GitCodingApplyProject();
for(const [index,change] of seed.changes.entries()) {
 const name=change.path;
 receipt={...receipt,files:receipt.files.map((f,n)=>n===index?{...f,status:'started'}:f)};
 store.codingApplications.atomic(tx=>tx.putApplication(receipt));
 if(phase==='started'&&index===0)halt();
 fs.appendFileSync(path+'.effects',name+'\n');
 await adapter.applyFile(project,change,{ownerId:seed.ownerId,taskId:'task',applicationId:receipt.id,changesetHash:receipt.changesetHash});
 if((phase==='file'&&index===0)||(phase==='partial'&&index===1))halt();
 receipt={...receipt,files:receipt.files.map((f,n)=>n===index?{...f,status:'completed'}:f)};
 store.codingApplications.atomic(tx=>tx.putApplication(receipt));
}
if(phase==='all_files')halt();
store.close();release();
`;
export async function killAt(
  path: string,
  project: string,
  phase: string,
  seed?: {
    ownerId: string;
    changesetHash: string;
    base: string;
    changes: readonly CodingFileChange[];
  },
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      worker,
      repository,
      path,
      project,
      phase,
      ...(seed ? [JSON.stringify(seed)] : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (buffer: Buffer) => {
    errors += buffer.toString();
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve());
    child.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('fault boundary timeout: ' + errors)), 10000);
      child.stdout.once('data', (buffer: Buffer) => {
        clearTimeout(timeout);
        if (buffer.toString().trim() === phase) resolve();
        else reject(Error('unexpected boundary'));
      });
      child.once('close', () => {
        clearTimeout(timeout);
        reject(Error('worker exited: ' + errors));
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}
