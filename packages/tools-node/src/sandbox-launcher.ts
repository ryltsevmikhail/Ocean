import { fingerprintFile } from './sandbox-mounts.js';
import { lstat } from 'node:fs/promises';
/** Trusted bootstrap executed inside the supervised unit before bubblewrap.
 * Mount source descriptors are inherited by bubblewrap, avoiding host proc access.
 */
export async function sandboxLauncher(argv: readonly string[]): Promise<string> {
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
    i += 2;
  }
  return `
    const fs=require('node:fs'), cp=require('node:child_process'),crypto=require('node:crypto');
    const argv=${JSON.stringify(argv)}, identities=${JSON.stringify(identities)}, descriptors=[];
    try {
      for(let i=0;i<argv.length;i++) {
        if(argv[i]!=='--bind' && argv[i]!=='--ro-bind') continue;
        if(argv[i+1]==='/dev/null') {i+=2;continue;}
        const fd=fs.openSync(argv[i+1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        descriptors.push(fd);
        const stat=fs.fstatSync(fd,{bigint:true});
        const actual=[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].map(String);
        if(stat.isFile()) {
          const hash=crypto.createHash('sha256');
          hash.update(JSON.stringify([String(stat.mode),String(stat.size)]));
          const buffer=Buffer.alloc(65536);
          let length;
          while((length=fs.readSync(fd,buffer,0,buffer.length,null))>0)
            hash.update(buffer.subarray(0,length));
          actual.push(hash.digest('hex'));
          const after=fs.fstatSync(fd,{bigint:true});
          if(after.ctimeNs!==stat.ctimeNs || after.mtimeNs!==stat.mtimeNs || after.size!==stat.size)
            throw Error('mount source changed while hashing');
        }
        if(JSON.stringify(actual)!==JSON.stringify(identities[argv[i+1]]))
          throw Error('mount source changed before opening');
        if(!stat.isFile()&&!stat.isDirectory()) throw Error('unsupported mount source');
        argv[i]=argv[i]==='--bind'?'--bind-fd':'--ro-bind-fd';
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
