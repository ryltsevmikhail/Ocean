import type { ManagedWorkspace } from '@runnets/domain';
import { desktopBtrfsProgram } from './desktop-btrfs-anchor.js';
/** Runs on the very descriptor inherited by bwrap, before any untrusted executable. */
export function managedWorkspaceBootstrap(expected: ManagedWorkspace): string {
  return `
    const expectedWorkspace=${JSON.stringify(expected)};
    function checkWorkspace(fd,source){
      if(source!==expectedWorkspace.root)return;
      const st=fs.fstatSync(fd,{bigint:true});
      if(!st.isDirectory() || String(st.dev)!==expectedWorkspace.dev || String(st.ino)!==expectedWorkspace.ino || fs.realpathSync('/proc/self/fd/'+fd)!==source || fs.realpathSync(source)!==source || fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==expectedWorkspace.boot)throw Error('managed root changed');
      const decode=s=>s.replace(/\\\\(040|011|012|134)/g,(_,n)=>String.fromCharCode(parseInt(n,8)));
      const raw=fs.readFileSync('/proc/self/mountinfo');
      if(raw.length>1048576)throw Error('managed mount limit');
      const rows=raw.toString().trim().split('\\n').map(s=>s.split(' '));
      if(rows.length>4096)throw Error('managed mount limit');
      const mountId=n=>/^mnt_id:\\s+([0-9]+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/'+n,'utf8'))?.[1];
      const id=mountId(fd), matches=rows.filter(r=>r[0]===id);
      if(matches.length!==1)throw Error('managed mount missing');
      const mount=matches[0], root=decode(mount[3]), point=decode(mount[4]), split=mount.indexOf('-');
      if(split<6 || rows.some(r=>r[0]!==id && (decode(r[4])===source || decode(r[4]).startsWith(source+'/'))))throw Error('managed nested mount');
      if(mount[split+1]==='btrfs'){
        const subvol=mount[split+3].split(',').find(s=>s.startsWith('subvol='))?.slice(7);
        if(!subvol || decode(subvol)!==root)throw Error('managed mount alias');
      }else if(root!=='/')throw Error('managed mount alias');
      const coordinate=path.posix.join(root,path.posix.relative(point,source));
      const overlaps=(a,b)=>a===b || a.startsWith(b==='/'?'/':b+'/') || b.startsWith(a==='/'?'/':a+'/');
      if(rows.some(r=>r[0]!==id && r[2]===mount[2] && overlaps(coordinate,decode(r[3]))))throw Error('managed mount import');
      if(expectedWorkspace.anchor!==null){
        const result=cp.spawnSync('/usr/bin/python3',['-I','-S','-c',${JSON.stringify(desktopBtrfsProgram)}],{cwd:'/',env:{},stdio:['ignore','pipe','pipe',fd],encoding:'utf8',timeout:2000,maxBuffer:4096});
        if(result.error || result.status!==0 || result.signal || result.stderr || !result.stdout)throw Error('managed anchor missing');
        const v=JSON.parse(result.stdout), actual=['linux-btrfs-v1',v.filesystem,v.subvolume,v.subvolumeId,v.type,v.handle].join(':');
        if(actual!==expectedWorkspace.anchor)throw Error('managed anchor changed');
      }
      let count=0;const deadline=Date.now()+15000;
      function walk(dir){
        if(Date.now()>=deadline)throw Error('managed inventory deadline');
        const before=fs.fstatSync(dir,{bigint:true}), listing=fs.opendirSync('/proc/self/fd/'+dir,{encoding:'latin1',bufferSize:32});
        try{for(let entry=listing.readSync();entry;entry=listing.readSync()){
          const rawName=Buffer.from(entry.name,'latin1'), decodedName=rawName.toString('utf8');
          if(!rawName.equals(Buffer.from(decodedName,'utf8')))throw Error('unsupported managed filename');
          if(++count>50000 || ['.git','node_modules','.ssh','.aws','.config','.npmrc','.netrc','.DS_Store'].includes(decodedName) || /^\\.env(?:\\.|$)/i.test(decodedName) || /\\.(?:pem|key|p12|pfx)$/i.test(decodedName) || /^id_(?:rsa|ed25519)/.test(decodedName) || /^\\.ocean-(?:recovery-|.*\\.tmp$)/.test(decodedName))throw Error('managed file denied');
          const name=path.join('/proc/self/fd/'+dir,decodedName), child=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
          try{const s=fs.fstatSync(child,{bigint:true});
            if(mountId(child)!==id || s.dev!==st.dev || fs.realpathSync('/proc/self/fd/'+child)!==path.join(fs.realpathSync('/proc/self/fd/'+dir),decodedName))throw Error('managed mount changed');
            if(s.isDirectory())walk(child);else if(!s.isFile() || s.nlink!==1n)throw Error('managed file alias');
          }finally{fs.closeSync(child);}
        }}finally{listing.closeSync();}
        if(before.ctimeNs!==fs.fstatSync(dir,{bigint:true}).ctimeNs)throw Error('managed inventory changed');
      }
      walk(fd);
    }
  `;
}
