"""Focused correction3 snapshot and read-only verification of three prior chains."""
import hashlib,json,pathlib,shutil,sys,time,os,ast
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix3'
NAMES=['identities', 'identity-test', 'process', 'finalize', 'supervise', 'fix1-integration-test', 'fix3-test', 'fix3-gates', 'fix3-freeze', 'fix1-gates', 'fix2-regression-test', 'fix2-controls-test', 'resources', 'resource-test', 'private-output', 'orphan-fixture', 'scope', 'scope-pilot', 'scope-test']
OLD=[(Q,'offline-seal','53b0413d5a5be9088bd494f0a754661eecdf2986b65464c9ac9079e7c625b7c8','e5f1cd1d9bc7c2e30a6bc369ffc717c86e4e878715f32ece48a6d2cbd47ccf7a'),(Q,'final-seal','503ad1f1e99010a83b492d24c4465c229bf940f37b28c3db2700a5daf4936121','df6df7a2045f6acd1e4096f6c575811422d199444353ce83c6ab372c5c803a19'),(Q/'fix1','freeze-final','d13375cf4a2557af7128617fe84013a1659c892c7f39d4ea68052a611ae6ad93','861bd2c9867cf12fcba5dfa9d7a167d5089487647da1fe516ca625d523e65b06'),(Q/'fix2','freeze-final','cf5a086324004e1f43216f357d84863768134ad10e1fc21fb1f1ecd8739b28c4','b72a7b089bf32704b9015eaf004c02521285c0b99e1efd32d783ce518f01c04c')]
def sha(p):
    with p.open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(p,v):
    with p.open('x')as f:json.dump(v,f,indent=2);f.write('\n')
def read(p):return json.loads(p.read_text())
def prior_chains():
    result=[]
    for base,name,seal,inventory in OLD:
        assert sha(base/name/'seal.json')==seal and sha(base/name/'inventory.json')==inventory
        rows=read(base/name/'inventory.json')
        for path,value in rows.items():
            f=base/path;assert sha(f)==value['sha256']and f.stat().st_size==value['bytes']and f.stat().st_mode&0o777==value['mode'],path
        result.append({'path':str(base/name),'seal':seal,'inventory':inventory,'verifiedFiles':len(rows)})
    assert sha(Q/'validation-final/attestation.json')=='b6a284f1d058e90038c50c90976544cfcaceb77099faac5c7a76df4d87de6fca'
    assert sha(Q/'fix1/validation-final/attestation.json')=='7d8bdd010340e4c42d9ac91e952d30d4f40f7658d9ac6a6cbaca2647efaa78c9'
    assert sha(Q/'fix2/validation-final/attestation.json')=='b20ab0fac97c89b1ef6c9e146a95986f6fb65e8be0ec959dd27f1dccfa2621c3'
    previous=read(Q/'fix1/old-chain-references.json')['old17.3Anchors']
    for name,digest in previous.items():assert sha(Q.parent/'task-17.3-ec1e5d5'/name)==digest
    return {'chains':result,'old17.3SixAnchors':previous}
def verify(target,digest):
    assert sha(target/'seal.json')==digest;seal=read(target/'seal.json');assert sha(target/'inventory.json')==seal['inventorySha256'];rows=read(target/'inventory.json')
    required={'runs/final/commands.json','runs/final/syntax.json','runs/final/fix3-test.log','logs/red-final.log','logs/shared-pid-red.log','prior-chain-references.json','historical-scope-attribution.json','selection.json'}
    assert required<=rows.keys()
    for path,value in rows.items():
        f=F/path;assert sha(f)==value['sha256']and f.stat().st_size==value['bytes']and f.stat().st_mode&0o777==value['mode'],path
    return {'verified':len(rows),'seal':digest}
if sys.argv[1]=='verify':print(json.dumps(verify(pathlib.Path(sys.argv[2]),sys.argv[3])));sys.exit(0)
assert sys.argv[1]=='freeze';target=F/'freeze-final';target.mkdir(mode=0o700);inputs=target/'inputs';inputs.mkdir(mode=0o700)
syntax=[]
for name in ['task-17.4-'+n+'.py'for n in NAMES]:
    source=P/name;ast.parse(source.read_text());lines=len(source.read_text().splitlines());assert lines<=300;shutil.copyfile(source,inputs/name);syntax.append({'file':name,'lines':lines,'astParseExit':0,'sha256':sha(source)})
for name in ['run-private.py','task-17.4-location.json','task-17.4-fix3.md','task-17.4-fix2-review.md']:shutil.copyfile(P/name,inputs/name)
write(F/'final-source-syntax.json',syntax);write(F/'prior-chain-references.json',prior_chains())
excluded={'freeze.stdout','freeze.stderr','freeze-invocation.json'}
files=[p for p in F.rglob('*')if p.is_file()and target not in p.parents and p.name not in excluded and 'validation-final'not in p.relative_to(F).parts]+list(inputs.iterdir())
rows={str(p.relative_to(F)):{'sha256':sha(p),'bytes':p.stat().st_size,'mode':p.stat().st_mode&0o777}for p in sorted(files)}
write(target/'inventory.json',rows);write(target/'seal.json',{'inventorySha256':sha(target/'inventory.json'),'files':len(rows),'argv':sys.argv,'cwd':os.getcwd(),'collectorSha256':sha(pathlib.Path(__file__)),'time':time.time()})
print(json.dumps({'files':len(rows),'sealSha256':sha(target/'seal.json'),'inventorySha256':sha(target/'inventory.json')},indent=2))
