/** Trusted bootstrap executed inside the supervised unit before bubblewrap.
 * Mount source descriptors are inherited by bubblewrap, avoiding host proc access.
 */
export function sandboxLauncher(argv: readonly string[]): string {
  return `
    const fs=require('node:fs'), cp=require('node:child_process');
    const argv=${JSON.stringify(argv)}, descriptors=[];
    try {
      for(let i=0;i<argv.length;i++) {
        if(argv[i]!=='--bind' && argv[i]!=='--ro-bind') continue;
        if(argv[i+1]==='/dev/null') {i+=2;continue;}
        const fd=fs.openSync(argv[i+1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        descriptors.push(fd);
        const stat=fs.fstatSync(fd);
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
