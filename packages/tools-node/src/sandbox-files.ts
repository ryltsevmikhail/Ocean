import { ToolError } from '@runnets/application';
import { checkedPath, type WorkspaceBackend } from './backend.js';
import { runSandbox, type SandboxRequest } from './sandbox-supervision.js';

/** Fixed filesystem worker; project code is never imported for file operations. */
const worker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0,'utf8'));
function target(relative, missing=false) {
  let current='/workspace';
  const parts=relative==='.'?[]:relative.split('/');
  parts.forEach((part,index)=>{
    current=path.join(current,part);
    try {
      const stat=fs.lstatSync(current);
      if(stat.isSymbolicLink() || (!stat.isDirectory() && index<parts.length-1)) throw Error('path_denied');
    } catch(e) {if (!(missing && index===parts.length-1 && e.code==='ENOENT')) throw e;}
  });
  return current;
}
function read(relative) {
  let file;
  try { file=fs.openSync(target(relative),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK); }
  catch(e) {if(e.code==='ENOENT') return null; throw e;}
  try {
    const stat=fs.fstatSync(file);
    if(!stat.isFile() || stat.nlink!==1 || stat.size>131072) throw Error('unsupported_file');
    const body=Buffer.alloc(131073);
    let length=0, n;
    while(length<body.length && (n=fs.readSync(file,body,length,body.length-length,null))>0) length+=n;
    if(length>131072) throw Error('file_too_large');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body.subarray(0,length));
    if(text.includes('\0')) throw Error('binary_file');
    return text;
  } finally {fs.closeSync(file);}
}
let installed=false;
try {
  let result;
  if(input.op==='read') result=read(input.path);
  else if(input.op==='list') result=fs.readdirSync(target(input.path),{withFileTypes:true})
    .filter(e=>!e.isSymbolicLink()).map(e=>({name:e.name,directory:e.isDirectory()}));
  else {
    if(read(input.path)!==input.expected) throw Error('stale_read');
    const dest=target(input.path,true);
    const temp=path.join(path.dirname(dest),'.ocean-'+crypto.randomUUID()+'.tmp');
    const mode=input.expected===null?0o600:fs.lstatSync(dest).mode&0o777;
    let fd;
    try {
      fd=fs.openSync(temp,'wx',0o600);
      fs.writeFileSync(fd,input.content);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      if(read(input.path)!==input.expected) throw Error('stale_read');
      if(input.expected===null) fs.linkSync(temp,dest);else fs.renameSync(temp,dest);
      installed=true;
      if(input.expected===null) fs.unlinkSync(temp);
      const directory=fs.openSync(path.dirname(dest),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      result=true;
    } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
  }
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch(e) {process.stdout.write(JSON.stringify({ok:false,code:installed?'effect_uncertain':e.message}));}
`;
export async function sandboxFile(
  options: Pick<SandboxRequest, 'root' | 'mounts' | 'dependencyProjectRoot'>,
  input: {
    op: 'read' | 'list' | 'write';
    path: string;
    content?: string;
    expected?: string | null;
  },
): Promise<unknown> {
  const path = checkedPath(input.path);
  const evidence = await runSandbox({
    ...options,
    program: '/toolchain/node',
    args: ['-e', worker],
    stdin: JSON.stringify({ ...input, path }),
    outputBytes: 1048576,
  });
  if (!evidence.cleanupConfirmed || evidence.reason !== 'exit')
    throw new ToolError('effect_uncertain', 'filesystem worker cleanup unconfirmed');
  if (evidence.exitCode !== 0 || evidence.truncated)
    throw new ToolError('effect_uncertain', 'filesystem worker result unavailable');
  const result = JSON.parse(evidence.output) as { ok: boolean; result?: unknown; code?: string };
  if (!result.ok) throw new ToolError(result.code ?? 'file_error', 'filesystem operation refused');
  return result.result;
}
export type SandboxBackend = WorkspaceBackend;
