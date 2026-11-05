"""Correction-only immutable evidence; old chains are read and never rewritten."""
import hashlib,json,pathlib,shutil,subprocess,sys,time,os
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix1'
NAMES=['identities','identity-test','scope','scope-test','resources','resource-test','supervise','freeze','fix1-integration-test','fix1-gates','fix1-freeze']
def sha(p):
    with p.open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(p,v):
    with p.open('x')as f:json.dump(v,f,indent=2);f.write('\n')
def read(p):return json.loads(p.read_text())
def old_chains():
    entries={};total=0
    for name,sealHash,inventoryHash in [('offline-seal','53b0413d5a5be9088bd494f0a754661eecdf2986b65464c9ac9079e7c625b7c8','e5f1cd1d9bc7c2e30a6bc369ffc717c86e4e878715f32ece48a6d2cbd47ccf7a'),('final-seal','503ad1f1e99010a83b492d24c4465c229bf940f37b28c3db2700a5daf4936121','df6df7a2045f6acd1e4096f6c575811422d199444353ce83c6ab372c5c803a19')]:
        assert sha(Q/name/'seal.json')==sealHash and sha(Q/name/'inventory.json')==inventoryHash
        inventory=read(Q/name/'inventory.json')
        for path,v in inventory.items():
            p=Q/path;assert sha(p)==v['sha256'] and p.stat().st_size==v['bytes'] and p.stat().st_mode&0o777==v['mode'],path
        entries[name]={'seal':sealHash,'inventory':inventoryHash,'verifiedFiles':len(inventory)};total+=len(inventory)
    assert sha(Q/'validation-final/attestation.json')=='b6a284f1d058e90038c50c90976544cfcaceb77099faac5c7a76df4d87de6fca'
    previous=Q.parent/'task-17.3-ec1e5d5';anchors={'fix1/freeze-final/evidence-inventory.json':'e6753bfccdb01bdcf7b4ccb17718347beb405654deb1cbcbb70cf5faa79f300b','fix1/freeze-final/seal.json':'fceb6b3e54c20deefc4bd9698fd9ec850e4269bf7dbcd66fe02a7b9de9a28db5','fix1/validation-final/attestation.json':'81e9d8c011e9e8ad9e89ede72f727c2d6160307665bd085a568a104b84bd46cd','fix2/freeze-final/evidence-inventory.json':'d951ffd623ffa0a35740f697a35725dd7c74183564c58075c55ed52a44903f18','fix2/freeze-final/seal.json':'36f9a9ddf6b8205fb3d3e8d66f81476c3cfe1a2076c8ca86a437dbc8340f7963','fix2/validation-final/attestation.json':'d0a9945ec48d88a7aab85c9ec85365ee4de94ace58b02bec41b467353806609f'}
    for name,digest in anchors.items():assert sha(previous/name)==digest
    return {'old17.4':entries,'old17.4FilesVerified':total,'old17.3Anchors':anchors}
def verify(target,expected):
    assert sha(target/'seal.json')==expected
    seal=read(target/'seal.json');assert sha(target/'inventory.json')==seal['inventorySha256'];inventory=read(target/'inventory.json')
    required={'final2-commands.json','historical-predicates.json','old-chain-references.json','syntax.json','logs/final2-identity-test.log','logs/final2-scope-test.log','logs/final2-resource-test.log','logs/final2-fix1-integration-test.log'}
    assert required<=inventory.keys()
    for name,v in inventory.items():
        p=F/name;assert sha(p)==v['sha256'] and p.stat().st_size==v['bytes'] and p.stat().st_mode&0o777==v['mode'],name
    return {'verified':len(inventory),'seal':expected}
if sys.argv[1]=='verify':print(json.dumps(verify(pathlib.Path(sys.argv[2]),sys.argv[3])));sys.exit(0)
assert sys.argv[1]=='freeze';target=F/'freeze-final';target.mkdir(mode=0o700);inputs=target/'inputs';inputs.mkdir(mode=0o700)
for name in [*['task-17.4-'+n+'.py'for n in NAMES],'task-17.4-location.json','run-private.py','task-17.4-fix1.md','task-17.4-review.md']:shutil.copyfile(P/name,inputs/name)
write(F/'old-chain-references.json',old_chains())
excluded={'freeze.stdout','freeze.stderr','freeze-invocation.json'}
files=[p for p in F.rglob('*')if p.is_file() and target not in p.parents and p.name not in excluded and 'validation-final' not in p.relative_to(F).parts]+list(inputs.iterdir())
inventory={str(p.relative_to(F)):{'sha256':sha(p),'bytes':p.stat().st_size,'mode':p.stat().st_mode&0o777}for p in sorted(files)}
write(target/'inventory.json',inventory);write(target/'seal.json',{'inventorySha256':sha(target/'inventory.json'),'files':len(inventory),'argv':sys.argv,'cwd':os.getcwd(),'collectorSha256':sha(pathlib.Path(__file__)),'time':time.time()})
print(json.dumps({'files':len(inventory),'sealSha256':sha(target/'seal.json'),'inventorySha256':sha(target/'inventory.json')},indent=2))
