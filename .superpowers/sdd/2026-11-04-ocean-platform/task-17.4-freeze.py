"""Compact phase attestation. Exclusive outputs; SHA anchors do not hash themselves."""
import hashlib,json,pathlib,sys,os,time,shutil
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(p,v):
    with p.open('x') as f:json.dump(v,f,indent=2);f.write('\n')
def read(p):return json.loads(p.read_text())
mode=sys.argv[1]
if mode=='offline':
    phase=Q/'offline-acceptance4';proof=read(phase/'engine-proof.json');supervisor=read(phase/'supervisor-result.json');inner=read(phase/'inner-result.json')
    assert proof['durableReopen'] and proof['runtimeSocketClosed'] and proof['host']['run']['turnStatus']=='completed'
    assert [r['label'] for r in proof['runs']]==['cold','warm','tool','interrupted','stopped_endpoint']
    assert [r['outcome']['kind'] for r in proof['runs'][:3]]==['completed']*3
    assert len(proof['effects'])==1 and proof['noRetryOfUnknown']
    assert proof['loaded']['models'][0]['size_vram']==0
    assert supervisor['exit']==0 and supervisor['scopeGone'] and supervisor['pidIdentitiesGone'] and supervisor['oomFree'] and supervisor['privateNetnsDifferent'] and supervisor['backendClientNamespacesMatch']
    assert inner['captureExit']==0 and inner['listenersAfterBackendStop']['backend']=='closed'
    witness=[json.loads(line) for line in (phase/'http-witness.jsonl').read_text().splitlines()]
    assert not any(r.get('gap') or r.get('truncated') for r in witness)
    assert [r['kernelDrops'] for r in witness if 'kernelDrops' in r]==[0]
    for r in witness:
        if r.get('line','').startswith('POST /api/chat '):assert r['think'] is False and r['options']=={'num_ctx':4096,'num_predict':512}
    files=[p for p in phase.rglob('*') if p.is_file()]+[Q/'artifact-proof.json',Q/'setup/gguf-proof.json',Q/'setup/backend-license-inventory.json']
    target=Q/'offline-seal'
elif mode=='final':
    target=Q/'final-seal';files=[]
    for name in ['metadata-red','metadata-green','offline-native','tool-diagnostic','raw-diagnostic','offline-acceptance2','offline-acceptance3','offline-acceptance4','sparse-owner-preflight','sparse-owner-preflight2','sparse-owner-preflight3','online-mixed','offline-seal','logs','setup']:
        root=Q/name
        assert root.exists(),name
        files += [p for p in root.rglob('*') if p.is_file() and p.stat().st_size<40_000_000 and not p.name.endswith('.tar.zst')]
    files += [Q/n for n in ['artifact-proof.json','gate-ledger.json','final-gate-ledger.json','package-ledger.json','resources-summary.json','assets-final.json']]
    for name in ['cli/manifest.json','desktop/desktop-artifact.json']:
        if (Q/name).exists():files.append(Q/name)
else:
    seal=pathlib.Path(sys.argv[2]);expected=sys.argv[3]
    if len(sys.argv)>4:Q=pathlib.Path(sys.argv[4])
    assert sha(seal/'seal.json')==expected
    root=read(seal/'seal.json');assert sha(seal/'inventory.json')==root['inventorySha256']
    inventory=read(seal/'inventory.json')
    required={'offline-acceptance4/engine-proof.json','offline-acceptance4/effect-witness.jsonl','offline-acceptance4/network.json','offline-acceptance4/filesystem-capabilities.json','offline-acceptance4/cgroup-final.json','offline-acceptance4/supervisor-result.json','offline-acceptance4/http-witness.jsonl','artifact-proof.json'}
    if root['mode']=='final':required |= {'online-mixed/mixed-proof.json','online-mixed/supervisor-result.json','offline-seal/seal.json','assets-final.json','resources-summary.json','final-gate-ledger.json'}
    assert required <= inventory.keys(),'required evidence omitted'
    for name,record in inventory.items():
        p=Q/name;assert p.is_file() and p.stat().st_size==record['bytes'] and sha(p)==record['sha256'] and p.stat().st_mode&0o777==record['mode'],name
    print(json.dumps({'verified':len(inventory),'seal':expected}));sys.exit(0)
target.mkdir(mode=0o700);inputs=target/'inputs';inputs.mkdir(mode=0o700)
for source in [*P.glob('task-17.4-*.py'),*P.glob('task-17.4-*.txt'),P/'run-private.py',P/'task-17.3-desktop-package.py',P/'task-17.4-location.json']:
    shutil.copyfile(source,inputs/source.name)
files += [p for p in inputs.iterdir() if p.is_file()]
files=sorted(set(files));inventory={str(p.relative_to(Q)):{'bytes':p.stat().st_size,'mode':p.stat().st_mode&0o777,'sha256':sha(p)} for p in files}
write(target/'inventory.json',inventory)
write(target/'seal.json',{'inventorySha256':sha(target/'inventory.json'),'files':len(inventory),'mode':mode,'createdAt':time.time(),'argv':sys.argv,'cwd':os.getcwd(),'collectorSha256':sha(pathlib.Path(__file__))})
print(json.dumps({'files':len(inventory),'inventorySha256':sha(target/'inventory.json'),'sealSha256':sha(target/'seal.json'),'path':str(target)},indent=2))
