"""Rehash the owned exact bytes actually consumed; no old sealed paths are written."""
import hashlib,json,pathlib,subprocess
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
paths=[Q/'setup/ollama-linux-amd64.tar.zst',Q/'cli/ocean-1.1.0-rc.3-linux-x64.tar.gz']
for name in ['backend','models','prefix/lib/ocean/releases/1.1.0-rc.3','desktop/artifact/OceanDesktop-linux-x64']:
    paths += [p for p in (Q/name).rglob('*') if p.is_file() and not p.is_symlink()]
inventory={str(p.relative_to(Q)):{'bytes':p.stat().st_size,'sha256':sha(p),'mode':p.stat().st_mode&0o777} for p in sorted(set(paths))}
proof={'files':inventory,'sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=Q/'source',text=True).strip(),'sourceStatus':subprocess.check_output(['git','status','--porcelain'],cwd=Q/'source',text=True),'protectedHashes':{n:sha(P.parents[2]/n) for n in ['apps/cli/test-fixtures/github-session-rig.ts','apps/cli/src/plugin-catalog-lifetime.test.ts']}}
assert proof['sourceStatus']==''
with (Q/'assets-final.json').open('x') as f:json.dump(proof,f,indent=2);f.write('\n')
print(json.dumps({'files':len(inventory),'assetsFinalSha256':sha(Q/'assets-final.json'),'sourceRevision':proof['sourceRevision'],'sourceClean':True,'protectedHashes':proof['protectedHashes']},indent=2))
