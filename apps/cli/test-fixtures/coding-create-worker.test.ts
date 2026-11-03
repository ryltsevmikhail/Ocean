import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const worker = String.raw`
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [repository,directory,phase]=process.argv.slice(1);
const project=join(directory,'project'), dbPath=join(directory,'runtime.sqlite');
const halt=()=>{fs.writeSync(1,phase+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const execute=cp.execFile;
cp.execFile=(program,args,options,callback)=>{
 const add=args.includes('worktree')&&args.includes('add'), tree=args.includes('read-tree');
 if(tree&&phase==='before_read_tree')halt();
 return execute(program,args,options,(error,...rest)=>{
  if(!error&&((add&&phase==='before_chmod')||(tree&&phase==='after_read_tree')))halt();
  callback(error,...rest);
 });
};
cp.execFile[promisify.custom]=(...args)=>new Promise((resolve,reject)=>{cp.execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));});
const chmod=fsp.chmod;
fsp.chmod=async(path,...args)=>{await chmod(path,...args);if(phase==='no_checkout'&&String(path).includes('/worktrees/'))halt();};
const open=fsp.open;
fsp.open=async(path,...args)=>{
 const handle=await open(path,...args);
 if(phase==='materializing'&&String(path).endsWith('/a')&&String(path).includes('/worktrees/')){
  const sync=handle.sync.bind(handle); handle.sync=async()=>{await sync();halt();};
 }
 return handle;
};
syncBuiltinESMExports();
const {GitCodingWorktrees}=await import(pathToFileURL(join(repository,'packages/tools-node/dist/index.js')));
const create=GitCodingWorktrees.prototype.create;
GitCodingWorktrees.prototype.create=async function(...args){
 fs.appendFileSync(join(directory,'dispatches'),'create\n');
 if(phase==='planned')halt();
 return create.apply(this,args);
};
const {createRuntime}=await import(pathToFileURL(join(repository,'apps/cli/dist/runtime.js')));
const runtime=createRuntime({dbPath,codingWorktreeDirectory:join(directory,'worktrees')}); await runtime.ready;
let seq=0;
const command=value=>{const r=runtime.conversations.execute({workspaceId:'ws_ocean',requestId:String(++seq),...value});if(!r.ok)throw Error(r.error.code);return r.value.data.id;};
command({type:'BindWorkspace',root:project});
const dev=command({type:'CreateBot',handle:'dev',name:'dev',role:'fixture',provider:'fixture',model:'fixture'});
const room=command({type:'OpenDirectRoom',botId:dev});
const reviewer=command({type:'CreateBot',handle:'review',name:'review',role:'fixture',provider:'fixture',model:'fixture'});
const reviewRoom=command({type:'OpenDirectRoom',botId:reviewer});
const result=await runtime.coding.start({workspaceId:'ws_ocean',taskId:'task',requestId:'start',projectRoot:project,ownerRoomId:room,devBotId:dev,reviewRoomId:reviewRoom,reviewBotId:reviewer,devCapabilities:['project_read'],testPresets:[]},{confirm:async()=>true});
if(!result.ok)throw Error(result.error.code);
const access={workspaceId:'ws_ocean',taskId:'task',roomId:room,botId:dev,policyVersion:1,capability:'project_read'};
fs.writeFileSync(join(directory,'access.json'),JSON.stringify(access));
const prepared=await runtime.codingChanges.prepare(access,{confirm:async()=>true});
throw Error('missed boundary: '+JSON.stringify(prepared));
`;
export async function killCreateAt(directory: string, home: string, phase: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', worker, repository, directory, phase],
    { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  const closed = once(child, 'close');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killed = false;
  try {
    const result = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data).trim()),
      closed.then(() => {
        throw Error('create worker exited: ' + errors);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('boundary timeout: ' + errors)), 15000);
      }),
    ]);
    if (result !== phase) throw Error('unexpected create boundary: ' + result);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    const [code, signal] = await closed;
    killed = code === null && signal === 'SIGKILL';
  }
  if (!killed) throw Error('create worker not killed: ' + errors);
}
