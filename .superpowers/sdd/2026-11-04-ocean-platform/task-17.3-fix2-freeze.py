"""Small fix2 evidence chain; references immutable fix1 rather than rebuilding product qualification."""
import hashlib,json,pathlib,shutil,subprocess,sys,tempfile
PLAN=pathlib.Path(__file__).resolve().parent
DRIVERS=tuple('task-17.3-'+n for n in ['owner-lifecycle.txt','owner-cleanup-test.py','proof-output.txt','proof-output-test.py','rebind-probe.txt','rebind-checked.py','tty-confirm.py','run-private.py','fix2-freeze.py'])
FILES=('fix2/owner-cases.json','fix2/correction-commands.json','fix2/checked-driver-inputs.json','fix2/recovery.json','fix2/accidental-old-driver-proof.json','fix2/recovered-original-proof.json','rebind-proof.json','fix1/freeze-final/seal.json','fix1/freeze-final/evidence-inventory.json','fix1/validation-final/attestation.json')
LOGS=('owner-exit23-red.log','owner-green.log','proof-red.log','proof-red-final.log','proof-green.log','rebind-invalid.log','rebind-valid.log','fix1-after-recovery.log','rebind-invalid-checked.log','rebind-valid-checked.log','syntax.log')
REHEARSAL=('proof.json','tty-confirm.json','commands.json','owner-cleanup.json','inspect.json','selection.json','http-effects.jsonl')
SEAL1='fceb6b3e54c20deefc4bd9698fd9ec850e4269bf7dbcd66fe02a7b9de9a28db5'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def record(p):return {'sha256':sha(p),'bytes':p.stat().st_size,'mode':p.stat().st_mode&511}
def required(root,out):
    prefix=str(out.relative_to(root));names=set(FILES);names.update('fix2/logs/'+n for n in LOGS);names.update('rebind-valid-fix2-checked/'+n for n in REHEARSAL);names.update(prefix+'/inputs/current/'+n for n in DRIVERS)
    cases=load(root/'fix2/owner-cases.json');assert len(cases)==8 and sum(c['red'] for c in cases)==1
    for case in cases:names.update(case['files'])
    return names

def check_inventory(root,out,inventory):
    if set(inventory['files'])!=required(root,out):raise ValueError('required evidence omission')
    for name,expected in inventory['files'].items():
        path=root/name
        if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts or path.is_symlink() or not path.resolve().is_relative_to(root):raise ValueError('unsafe evidence path')
        if record(path)!=expected:raise ValueError('changed evidence: '+name)
    if sha(root/'fix1/freeze-final/seal.json')!=SEAL1:raise ValueError('old seal changed')
    return len(inventory['files'])

def verify(root,out,anchor):
    if sha(out/'seal.json')!=anchor:raise ValueError('seal anchor mismatch')
    seal=load(out/'seal.json')
    if seal['exit']!=0 or set(seal['files'])!={'invocation.json','stdout.log','stderr.log','evidence-inventory.json'}:raise ValueError('incomplete freeze result')
    for name,expected in seal['files'].items():
        if record(out/name)!=expected:raise ValueError('changed freeze result')
    return check_inventory(root,out,load(out/'evidence-inventory.json'))

mode=sys.argv[1];root=pathlib.Path(sys.argv[2]).resolve();out=pathlib.Path(sys.argv[3]).resolve()
if mode=='collect':
    assert sha(root/'cli/ocean-1.1.0-rc.3-linux-x64.tar.gz')=='933d0b3a535685a4606e92c91ecd970507e0d403002d2e348cfb2b304302556d'
    assert sha(root/'desktop/artifact/OceanDesktop-linux-x64/resources/app.asar')=='96837046186d298fb6466e723ecba8c31c58dadf1e7925b26e8f0c66a660b06a'
    expected=load(root/'fix2/checked-driver-inputs.json')
    for name,digest in expected.items():assert sha(out/'inputs/current'/name)==digest
    cleanup=load(root/'rebind-valid-fix2-checked/owner-cleanup.json');assert not cleanup.get('failure') and len(cleanup['owners'])==3
    assert all(o['cleanup']['exit']['code']==0 and o['cleanup']['leaderReaped'] and o['cleanup']['groupGone'] for o in cleanup['owners'])
    tty=load(root/'rebind-valid-fix2-checked/tty-confirm.json');decision=tty['stdout']['data'];assert decision['bindingDigest'] in tty['preview'] and decision['decisionId'] in tty['preview'] and decision['status']=='allowed'
    names=required(root,out);inventory={'format':1,'artifactSourceRevision':'ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a','fixBase':'fc8443d28763f40781f05fd28d66698ffd92d67e','immutableFix1SealSha256':SEAL1,'files':{n:record(root/n) for n in sorted(names)}}
    check_inventory(root,out,inventory);(out/'evidence-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n');print(json.dumps({'files':len(names),'inventorySha256':sha(out/'evidence-inventory.json'),'unchangedProductSource':inventory['artifactSourceRevision']}))
elif mode=='freeze':
    assert out.is_relative_to(root/'fix2');out.mkdir(mode=0o700);(out/'inputs/current').mkdir(parents=True,mode=0o700)
    for name in DRIVERS:(out/'inputs/current'/name).write_bytes((PLAN/name).read_bytes())
    argv=['python3',str(out/'inputs/current/task-17.3-run-private.py'),'python3',str(out/'inputs/current/task-17.3-fix2-freeze.py'),'collect',str(root),str(out)]
    (out/'invocation.json').write_text(json.dumps({'argv':argv,'cwd':str(PLAN.parents[2]),'wrapperArgv':[sys.executable,*sys.argv]},indent=2)+'\n');result=subprocess.run(argv,cwd=PLAN.parents[2],capture_output=True)
    (out/'stdout.log').write_bytes(result.stdout);(out/'stderr.log').write_bytes(result.stderr)
    seal={'exit':result.returncode,'files':{n:record(out/n) for n in ['invocation.json','stdout.log','stderr.log']+(['evidence-inventory.json'] if (out/'evidence-inventory.json').exists() else [])}};(out/'seal.json').write_text(json.dumps(seal,indent=2)+'\n')
    print(json.dumps({'exit':result.returncode,'sealSha256':sha(out/'seal.json'),'inventorySha256':sha(out/'evidence-inventory.json') if (out/'evidence-inventory.json').exists() else None},indent=2));sys.stderr.buffer.write(result.stderr);raise SystemExit(result.returncode)
elif mode=='verify':print(json.dumps({'files':verify(root,out,sys.argv[4]),'sealSha256':sys.argv[4],'verified':True}))
elif mode=='controls':
    anchor=sys.argv[4];assert verify(root,out,anchor)>30;temporary=pathlib.Path(tempfile.mkdtemp(prefix='negative-',dir=root/'fix2'))
    try:
        copy_out=temporary/out.relative_to(root);inventory=load(out/'evidence-inventory.json')
        for name in inventory['files']:
            target=temporary/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,target)
        copy_out.mkdir(parents=True,exist_ok=True)
        for name in ['seal.json','invocation.json','stdout.log','stderr.log','evidence-inventory.json']:shutil.copy2(out/name,copy_out/name)
        assert verify(temporary,copy_out,anchor)>30
        target=temporary/'rebind-valid-fix2-checked/proof.json';original=target.read_bytes();target.write_bytes(b'changed')
        try:verify(temporary,copy_out,anchor)
        except ValueError:pass
        else:raise AssertionError('tampered proof accepted')
        target.write_bytes(original);omitted=load(copy_out/'evidence-inventory.json');del omitted['files']['rebind-valid-fix2-checked/proof.json']
        try:check_inventory(temporary,copy_out,omitted)
        except ValueError:pass
        else:raise AssertionError('omitted proof accepted')
        print(json.dumps({'passed':3,'failed':0,'controls':['actual final chain','copied proof tamper refused','manifest proof omission refused'],'candidateMutations':0}))
    finally:shutil.rmtree(temporary)
else:raise ValueError('unknown mode')
