import { runInNewContext } from 'node:vm';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/** Trusted tree attestation shared by the host and bootstrap. Symlinks are hashed without traversal. */
export const treeFingerprintScript = String.raw`
(root) => {
  const hash=crypto.createHash('sha256');
  let count=0, bytes=0;
  function walk(path,relative) {
    if(++count>100000) throw Error('dependency inventory limit');
    const stat=fs.lstatSync(path);
    hash.update(JSON.stringify([relative,stat.mode]));
    if(stat.isSymbolicLink()) hash.update(JSON.stringify(fs.readlinkSync(path)));
    else if(stat.isDirectory()) {
      for(const name of fs.readdirSync(path).sort()) walk(path+'/'+name,relative+'/'+name);
    } else if(stat.isFile() && stat.nlink===1) {
      const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try {
        const before=fs.fstatSync(fd,{bigint:true});
        if(!before.isFile()) throw Error('dependency file changed');
        if(before.size>BigInt(1073741824-bytes)) throw Error('dependency byte limit');
        hash.update(JSON.stringify(String(before.size)));
        const buffer=Buffer.alloc(65536);
        let length;
        while((length=fs.readSync(fd,buffer,0,buffer.length,null))>0) {
          bytes+=length;
          if(bytes>1073741824) throw Error('dependency byte limit');
          hash.update(buffer.subarray(0,length));
        }
        const after=fs.fstatSync(fd,{bigint:true});
        if(before.ino!==after.ino || before.ctimeNs!==after.ctimeNs || before.size!==after.size)
          throw Error('dependency file changed');
      } finally {fs.closeSync(fd);}
    } else throw Error('unsupported dependency file');
  }
  walk(root,'');
  return hash.digest('hex');
}
`;
export function fingerprintTree(root: string): string {
  const fingerprint = runInNewContext(treeFingerprintScript, { fs, crypto, Buffer }) as (
    path: string,
  ) => string;
  return fingerprint(root);
}
