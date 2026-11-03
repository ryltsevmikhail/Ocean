import { fingerprintTree, treeFingerprintScript } from './sandbox-tree.js';
import { fingerprintFile } from './sandbox-mounts.js';
import { lstat } from 'node:fs/promises';
/** Trusted bootstrap executed inside the supervised unit before bubblewrap.
 * Mount source descriptors are inherited by bubblewrap, avoiding host proc access.
 */
export async function sandboxLauncher(
  argv: readonly string[],
  expectedInputs: Readonly<Record<string, string>> = {},
): Promise<string> {
  const trees: Record<string, string> = {};
  const identities: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--bind' && argv[i] !== '--ro-bind') continue;
    const source = argv[i + 1]!;
    if (source === '/dev/null') continue;
    const stat = await lstat(source, { bigint: true });
    identities[source] = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(
      String,
    );
    if (stat.isFile()) identities[source].push(await fingerprintFile(source));
    if (stat.isDirectory() && source !== '/usr' && argv[i] === '--ro-bind')
      trees[source] = fingerprintTree(source);
    const digest = stat.isFile() ? identities[source].at(-1) : trees[source];
    if (expectedInputs[source] !== undefined && digest !== expectedInputs[source])
      throw new Error('qualified sandbox input changed');
    i += 2;
  }
  return `
    // Reserved exit status for a supervisor the host stopped with a clean signal.
    // For non-oneshot services systemd reports SIGHUP, SIGINT, SIGTERM and SIGPIPE
    // as a clean service exit, so completion must not be inferred from a zero
    // status alone. Project code runs in a child PID namespace and cannot signal
    // or fake this status; Node ignores SIGPIPE by default, so it is trapped here
    // too instead of letting an external stop be silently ignored.
    for(const signal of ['SIGHUP','SIGINT','SIGTERM','SIGPIPE'])process.on(signal,()=>process.exit(75));
    const fs=require('node:fs'), cp=require('node:child_process'),crypto=require('node:crypto'),os=require('node:os'),path=require('node:path');
    const argv=${JSON.stringify(argv)}, identities=${JSON.stringify(identities)}, descriptors=[];
    const trees=${JSON.stringify(trees)}, fingerprintTree=(${treeFingerprintScript});
    const staged=[];
    process.once('exit',()=>{for(const dir of staged)fs.rmSync(dir,{recursive:true,force:true});});
    try {
      for(let i=0;i<argv.length;i++) {
        if(argv[i]!=='--bind' && argv[i]!=='--ro-bind') continue;
        if(argv[i+1]==='/dev/null') {i+=2;continue;}
        let fd=fs.openSync(argv[i+1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        descriptors.push(fd);
        const stat=fs.fstatSync(fd,{bigint:true});
        const actual=[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].map(String);
        if(stat.isFile()) {
          const hash=crypto.createHash('sha256');
          hash.update(JSON.stringify([String(stat.mode),String(stat.size)]));
          const scratch=fs.mkdtempSync(path.join(process.env.RUNTIME_DIRECTORY || os.tmpdir(),'ocean-executable-'));
          staged.push(scratch);
          const copyPath=path.join(scratch,'copy');
          const copy=fs.openSync(copyPath,'wx',0o600);
          try {
          const buffer=Buffer.alloc(65536);
          let length, offset=0;
          while((length=fs.readSync(fd,buffer,0,buffer.length,offset))>0) {
            hash.update(buffer.subarray(0,length));
            fs.writeFileSync(copy,buffer.subarray(0,length));
            offset+=length;
          }
          actual.push(hash.digest('hex'));
          const after=fs.fstatSync(fd,{bigint:true});
          if(after.ctimeNs!==stat.ctimeNs || after.mtimeNs!==stat.mtimeNs || after.size!==stat.size)
            throw Error('mount source changed while hashing');
          fs.fchmodSync(copy,Number(stat.mode&0o777n));
          const readonly=fs.openSync(copyPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
          fs.closeSync(fd);fd=readonly;descriptors[descriptors.length-1]=fd;
          } finally {
            fs.closeSync(copy);
          }
        }
        if(JSON.stringify(actual)!==JSON.stringify(identities[argv[i+1]]))
          throw Error('mount source changed before opening');
        if(!stat.isFile()&&!stat.isDirectory()) throw Error('unsupported mount source');
        argv[i]=argv[i]==='--bind'?'--bind-fd':'--ro-bind-fd';
        if(trees[argv[i+1]]) {
          const scratch=fs.mkdtempSync(path.join(process.env.RUNTIME_DIRECTORY || os.tmpdir(),'ocean-dependencies-'));
          staged.push(scratch);
          const copy=path.join(scratch,'tree');
          fs.cpSync('/proc/self/fd/'+fd+'/.',copy,{recursive:true,dereference:false,verbatimSymlinks:true});
          if(fingerprintTree(copy)!==trees[argv[i+1]]) throw Error('dependency snapshot changed');
          const pinned=fs.openSync(copy,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
          fs.closeSync(fd);fd=pinned;descriptors[descriptors.length-1]=fd;
        }
        argv[i+1]=String(descriptors.length+2);
        i+=2;
      }
      const child=cp.spawn('/usr/bin/bwrap',argv,{
        env:process.env,stdio:['inherit','inherit','inherit',...descriptors],shell:false});
      child.on('error',()=>process.exit(127));
      child.on('exit',(code)=>process.exit(code??128));
    } finally {for(const fd of descriptors)fs.closeSync(fd);}
  `;
}
