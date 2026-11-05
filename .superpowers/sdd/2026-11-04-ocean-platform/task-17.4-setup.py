"""Opt-in isolated setup; never executes downloaded bytes or alters system services."""
import hashlib,json,pathlib,subprocess,sys,time,urllib.request,os
P=pathlib.Path(__file__).resolve().parent
Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
S=Q/'setup'
def fetch(url,target):
    target=S/target
    if target.exists(): raise RuntimeError('refuse existing output '+str(target))
    start=time.monotonic()
    with urllib.request.urlopen(url,timeout=60) as response, target.open('xb') as out:
        while data:=response.read(1024*1024): out.write(data)
    digest=hashlib.file_digest(target.open('rb'),'sha256').hexdigest()
    record={'url':url,'path':str(target),'bytes':target.stat().st_size,'sha256':digest,'seconds':time.monotonic()-start}
    with (S/'downloads.jsonl').open('a') as f: f.write(json.dumps(record)+'\n')
    print(json.dumps(record),flush=True)
    return target
if sys.argv[1]=='metadata':
    release=json.loads(fetch('https://api.github.com/repos/ollama/ollama/releases/tags/v0.40.14','release-api.json').read_text())
    assert release['tag_name']=='v0.40.14' and not release['prerelease'] and not release['draft']
    asset=next(a for a in release['assets'] if a['name']=='ollama-linux-amd64.tar.zst')
    assert asset['size']==1525335029 and asset['digest']=='sha256:993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d'
    sums=fetch('https://github.com/ollama/ollama/releases/download/v0.40.14/sha256sum.txt','sha256sum.txt')
    matches=[line.split()[0] for line in sums.read_text().splitlines() if line.split()[-1].removeprefix('./')=='ollama-linux-amd64.tar.zst']
    assert matches==[asset['digest'].removeprefix('sha256:')]
    fetch('https://raw.githubusercontent.com/ollama/ollama/v0.40.14/LICENSE','ollama-LICENSE')
    manifest=fetch('https://registry.ollama.ai/v2/library/qwen3/manifests/1.7b','qwen3-manifest.json')
    assert hashlib.sha256(manifest.read_bytes()).hexdigest()=='8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7'
if sys.argv[1]=='assets':
    tar=fetch('https://github.com/ollama/ollama/releases/download/v0.40.14/ollama-linux-amd64.tar.zst','ollama-linux-amd64.tar.zst')
    assert tar.stat().st_size==1525335029 and hashlib.file_digest(tar.open('rb'),'sha256').hexdigest()=='993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d'
    manifest=json.loads((S/'qwen3-manifest.json').read_text())
    for item in [manifest['config'],*manifest['layers']]:
        digest=item['digest'].removeprefix('sha256:')
        blob=fetch('https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:'+digest,'sha256-'+digest)
        assert blob.stat().st_size==item['size'] and hashlib.file_digest(blob.open('rb'),'sha256').hexdigest()==digest
