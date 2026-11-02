import { ToolError } from '@runnets/application';
import { checkedPath, type WorkspaceBackend } from './backend.js';
import { runSandbox, type SandboxRequest } from './sandbox-supervision.js';

/** Fixed filesystem worker; project code is never imported for file operations. */
const worker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0,'utf8'));
function readFile(location) {
  let file;
  try { file=fs.openSync(location,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK); }
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
function openDirectory(relative) {
  const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
  let directory=fs.openSync('/workspace',flags);
  try {
    for(const part of relative.split('/').filter(part=>part!=='.')) {
      const next=fs.openSync('/proc/self/fd/'+directory+'/'+part,flags);
      fs.closeSync(directory);
      directory=next;
    }
    return directory;
  } catch(error) {fs.closeSync(directory);throw error;}
}
function verifyDirectory(relative,directory) {
  const current=openDirectory(relative);
  try {
    const actual=fs.fstatSync(current,{bigint:true});
    const pinned=fs.fstatSync(directory,{bigint:true});
    if(actual.dev!==pinned.dev || actual.ino!==pinned.ino) throw Error('stale_directory');
  } finally {fs.closeSync(current);}
}
let installed=false;
try {
  let result;
  const parent=input.op==='list'?input.path:path.dirname(input.path);
  let directory;
  try {directory=openDirectory(parent);}
  catch(error){if(input.op!=='read'||error.code!=='ENOENT')throw error;}
  if(directory===undefined) result=null;
  else try {
    const pinned='/proc/self/fd/'+directory;
    const dest=path.join(pinned,path.basename(input.path));
    if(input.op==='read') result=readFile(dest);
    else if(input.op==='list') result=fs.readdirSync(pinned,{withFileTypes:true})
      .filter(e=>!e.isSymbolicLink()).map(e=>({name:e.name,directory:e.isDirectory()}));
    else {
      if(readFile(dest)!==input.expected) throw Error('stale_read');
      const temp=path.join(pinned,'.ocean-'+crypto.randomUUID()+'.tmp');
      const mode=input.expected===null?0o600:fs.lstatSync(dest).mode&0o777;
      let fd, owned=false;
      try {
        fd=fs.openSync(temp,'wx',0o600);owned=true;
        fs.writeFileSync(fd,input.content);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
        verifyDirectory(parent,directory);
        if(readFile(dest)!==input.expected) throw Error('stale_read');
        if(input.expected===null) fs.linkSync(temp,dest);
        else {
          const displaced=path.join(pinned,'.ocean-recovery-'+crypto.randomUUID());
          fs.renameSync(dest,displaced);
          installed=true;
          fs.fsyncSync(directory);
          try {
            if(readFile(displaced)!==input.expected) throw Error('stale_read');
            verifyDirectory(parent,directory);
            fs.linkSync(temp,dest);
          } catch(error) {
            try {fs.linkSync(displaced,dest);fs.unlinkSync(displaced);fs.fsyncSync(directory);}
            catch {}
            throw error;
          }
          fs.unlinkSync(displaced);
        }
        installed=true;
        fs.unlinkSync(temp);
        owned=false;
        fs.fsyncSync(directory);
        result=true;
      } finally {if(fd!==undefined)fs.closeSync(fd);if(owned)fs.unlinkSync(temp);}
    }
    verifyDirectory(parent,directory);
  } finally {fs.closeSync(directory);}
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch(e) {process.stdout.write(JSON.stringify({ok:false,code:installed?'effect_uncertain':e.message}));}
`;
export async function sandboxFile(
  options: Pick<SandboxRequest, 'root' | 'mounts' | 'dependencyProjectRoot' | 'expectedInputs'>,
  input: {
    op: 'read' | 'list' | 'write';
    path: string;
    content?: string;
    expected?: string | null;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  const path = checkedPath(input.path);
  const evidence = await runSandbox({
    ...options,
    ...(signal ? { signal } : {}),
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
