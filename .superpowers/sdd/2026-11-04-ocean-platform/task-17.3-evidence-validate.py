"""Explicit qualification evidence set and non-circular seal validation."""
import hashlib,json,pathlib,sys
BASELINE_DRIVERS=tuple('task-17.3-'+name for name in ['archive-probe.py','closure-probe.txt','desktop-package.py','early-cancel-probe.txt','freeze-evidence.py','hosts-probe.py','native-history-diagnostic.txt','native-probe.py','rebind-probe.txt','sandbox-probe.txt','tty-confirm.py','v1-probe.py'])
CURRENT_DRIVERS=BASELINE_DRIVERS+tuple('task-17.3-'+name for name in ['owner-lifecycle.txt','owner-cleanup-test.py','stage-dependencies.py','run-private.py','evidence-validate.py','evidence-test.py','freeze-run.py'])
BASE_PROOFS=('archive-proof.json','v1-proof.json','rebind-proof.json','hosts-proof.json','sandbox-proof.json','early-cancel-proof.json','runtime-equivalence.json','electron-proof.json','licenses-proof.json','owned-cleanup-proof.json','gate-ledger.json','freeze.json','evidence-inventory.json','environment.txt','sandbox-dependency-provenance.json','cli/manifest.json','cli/ocean-1.1.0-rc.3-linux-x64.tar.gz','desktop/desktop-artifact.json','desktop/artifact/OceanDesktop-linux-x64/resources/app.asar','rebind-rehearsal/tty-confirm.json','rebind-rehearsal/commands.json','rebind-rehearsal/inspect.json','rebind-rehearsal/selection.json','rebind-rehearsal/http-effects.jsonl','hosts-rehearsal/commands.json','hosts-rehearsal/tui-environment.json')
BASE_LOGS=('install.log','check.log','desktop-bundle.log','native.log','package.log','desktop-package.log','archive.log','installed-commands.jsonl','closure.log','rebind.log','sandbox.log','early-cancel.log','v1.log','hosts.log','v1-commands.json','closure-final.log','closure-final-2.log','build-final.log','format-final.log','freeze.log','protected-checkout-format.log')
FIX_FILES=('fix1/dependency-reproduction.json','fix1/dependency-tree.json','fix1/owner-cases.json','fix1/rebind-proof.json','rebind-rehearsal-fix1/tty-confirm.json','rebind-rehearsal-fix1/commands.json','rebind-rehearsal-fix1/owner-cleanup.json','rebind-rehearsal-fix1/inspect.json','rebind-rehearsal-fix1/selection.json','rebind-rehearsal-fix1/http-effects.jsonl','fix1/previous-freeze/freeze.json','fix1/previous-freeze/evidence-inventory.json','fix1/previous-freeze/freeze.log')
FIX_LOGS=('owner-red.log','owner-green.log','owner-red-supervised.log','owner-green-final.log','dependencies.log','rebind.log','inventory-tests.log')
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def load(path):return json.loads(path.read_text())
def safe(root,name):
    p=pathlib.PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts:raise ValueError('unsafe evidence path')
    target=root/name
    if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):raise ValueError('evidence escaped root')
    return target

def required_files(root,output):
    relative=str(output.relative_to(root));required=set(BASE_PROOFS+FIX_FILES);required.update(['fix1/correction-commands.json','fix1/previous-freeze/inventory-tests-placeholder.log'])
    required.update('logs/'+n for n in BASE_LOGS);required.update('fix1/logs/'+n for n in FIX_LOGS)
    preliminary='fix1/freeze-preliminary/'
    required.update(preliminary+n for n in ['seal.json','invocation.json','stdout.log','stderr.log','evidence-inventory.json','inputs/provenance.json','freeze.json','electron-proof.json','licenses-proof.json','environment.txt','inputs/run-private.py','inputs/reproduce.md'])
    required.update(preliminary+'inputs/current/'+n for n in CURRENT_DRIVERS)
    required.update(preliminary+'inputs/baseline/'+n for n in BASELINE_DRIVERS)
    required.update(relative+'/inputs/current/'+n for n in CURRENT_DRIVERS)
    required.update(relative+'/inputs/baseline/'+n for n in BASELINE_DRIVERS)
    required.update(relative+'/'+n for n in ['inputs/run-private.py','inputs/provenance.json','inputs/reproduce.md','freeze.json','electron-proof.json','licenses-proof.json','environment.txt'])
    cases=load(root/'fix1/owner-cases.json')
    if len(cases)!=4:raise ValueError('missing focused owner case')
    for case in cases:
        for name in case['files']:
            if not name.startswith('fix1/owner-'):raise ValueError('unexpected focused fixture')
            required.add(name)
    return required

def validate_inventory(root,output,inventory):
    if inventory.get('format')!=2:raise ValueError('invalid inventory format')
    required=required_files(root,output)
    if set(inventory['files'])!=required or inventory['requiredFiles']!=sorted(required):raise ValueError('evidence omission or unexpected inclusion')
    for name,record in inventory['files'].items():
        p=safe(root,name)
        if p.stat().st_size!=record['bytes'] or sha(p)!=record['sha256']:raise ValueError('evidence content changed: '+name)
    tty=load(root/'rebind-rehearsal/tty-confirm.json');decision=tty['stdout']['data']
    if not (tty['stdinIsRealTTY'] and tty['stderrIsRealTTY'] and tty['exit']==0 and decision['status']=='allowed'):raise ValueError('missing actual TTY confirmation')
    if decision['bindingDigest'] not in tty['preview'] or decision['decisionId'] not in tty['preview']:raise ValueError('TTY card/digest mismatch')
    reproduced=load(root/'fix1/dependency-reproduction.json')
    if not reproduced['allFileBytesModesAndLinkTargetsEqual']:raise ValueError('dependency reproduction mismatch')
    provenance=load(output/'inputs/provenance.json');runner=output/'inputs/run-private.py'
    if sha(runner)!=provenance['originalSharedRunner']['sha256'] or runner.read_bytes()!=(output/'inputs/current/task-17.3-run-private.py').read_bytes():raise ValueError('shared runner identity mismatch')
    return {'files':len(required),'actualTTYCardBound':True,'sharedRunnerBound':True,'dependenciesReproduced':True}

def validate_chain(root,output,expected_seal_sha):
    seal_path=output/'seal.json'
    if sha(seal_path)!=expected_seal_sha:raise ValueError('immutable seal digest mismatch')
    seal=load(seal_path)
    if seal['exit']!=0:raise ValueError('freeze did not succeed')
    if set(seal['files'])!={'invocation.json','stdout.log','stderr.log','evidence-inventory.json'}:raise ValueError('incomplete seal')
    for name,record in seal['files'].items():
        p=output/name
        if sha(p)!=record['sha256'] or p.stat().st_size!=record['bytes']:raise ValueError('freeze sidecar changed: '+name)
    call=load(output/'invocation.json')
    recorded=pathlib.Path(call['freezeDirectory']);recorded_root=pathlib.Path(call['artifactRoot'])
    if str(recorded.relative_to(recorded_root))!=str(output.relative_to(root)):raise ValueError('freeze location mismatch')
    expected=['python3',str(recorded/'inputs/run-private.py'),'python3',str(recorded/'inputs/current/task-17.3-freeze-evidence.py'),str(recorded_root),str(recorded)]
    if call['argv']!=expected:raise ValueError('freeze invocation mismatch')
    result=validate_inventory(root,output,load(output/'evidence-inventory.json'))
    return {**result,'sealSha256':expected_seal_sha,'inventorySha256':sha(output/'evidence-inventory.json'),'freezeExit':seal['exit']}
if __name__=='__main__':
    root=pathlib.Path(sys.argv[1]).resolve();output=pathlib.Path(sys.argv[2]).resolve();print(json.dumps(validate_chain(root,output,sys.argv[3]),indent=2))
