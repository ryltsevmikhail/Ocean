"""Build clean exact committed source into a new disposable CLI/Desktop candidate."""
import hashlib,json,pathlib,subprocess,sys,time,tarfile
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);W=Q/'source';ledger=[]
def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def run(name,args,cwd):
    started=time.time()
    with (Q/'logs'/('package-'+name+'.log')).open('x') as out:
        r=subprocess.run(args,cwd=cwd,stdout=out,stderr=out,timeout=600,close_fds=True)
    ledger.append({'argv':args,'cwd':str(cwd),'exit':r.returncode,'seconds':time.time()-started})
    (Q/'package-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n');assert r.returncode==0,name;print(name,0,flush=True)
rev=sys.argv[1];assert len(rev)==40
if len(sys.argv)>2 and sys.argv[2]=='resume-after-private-cache-failure':
    ledger=json.loads((Q/'package-ledger.json').read_text())
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip()==rev
else: run('worktree',['git','worktree','add','--detach',str(W),rev],P.parents[2])
private=['python3',str(P/'run-private.py')]
run('cache-copy',['cp','-a','--reflink=auto','/home/ryltsevmg/.cache/pnpm',str(Q/'pnpm-cache')],W)
(Q/'pnpm-store').mkdir()
run('store-copy',['cp','-a','--reflink=auto','/home/ryltsevmg/.local/share/pnpm/store/v11',str(Q/'pnpm-store/v11')],W)
run('install-owned-cache',private+['pnpm','install','--frozen-lockfile','--offline','--cache-dir',str(Q/'pnpm-cache'),'--store-dir',str(Q/'pnpm-store')],W)
run('build',private+['pnpm','build'],W)
run('bundle',private+['pnpm','--filter','@ocean/desktop','bundle'],W)
run('cli',private+['pnpm','package:release','1.1.0-rc.3',str(Q/'cli')],W)
archive=Q/'cli/ocean-1.1.0-rc.3-linux-x64.tar.gz';digest=sha(archive)
with tarfile.open(archive) as tar:
    entries=tar.getmembers();assert all(e.isfile() and not pathlib.PurePosixPath(e.name).is_absolute() and '..' not in pathlib.PurePosixPath(e.name).parts for e in entries)
    manifest=json.loads(tar.extractfile('manifest.json').read());assert manifest['revision']==rev
    for name,item in manifest['files'].items():
        member=tar.getmember(name);assert hashlib.sha256(tar.extractfile(member).read()).hexdigest()==item['sha256'] and member.mode==item['mode']
run('prefix',private+['node',str(Q/'cli/ocean-install.mjs'),'--archive',str(archive),'--sha256',digest,'--prefix',str(Q/'prefix')],W)
cache=pathlib.Path('/home/ryltsevmg/.cache/electron/fb82adfe72ba90d98ee1fcb6b06511833495be5ee3638992b482dea07f0e7ad5/electron-v45.2.1-linux-x64.zip')
assert sha(cache)=='616efc1ae4784af1a4f3f0e8774e73e7030e7bd1708da9d09bcf543dfa499beb'
run('desktop',private+['python3',str(P/'task-17.3-desktop-package.py'),str(W),str(Q)],W)
assert subprocess.check_output(['git','status','--porcelain'],cwd=W,text=True)==''
asar=Q/'desktop/artifact/OceanDesktop-linux-x64/resources/app.asar'
proof={'revision':rev,'cli':{'path':str(archive),'bytes':archive.stat().st_size,'sha256':digest,'files':len(manifest['files'])},'desktopAsar':{'path':str(asar),'bytes':asar.stat().st_size,'sha256':sha(asar)},'sourceClean':True,'lockSha256':sha(W/'pnpm-lock.yaml'),'electronArchiveSha256':sha(cache)}
(Q/'artifact-proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof,indent=2))
