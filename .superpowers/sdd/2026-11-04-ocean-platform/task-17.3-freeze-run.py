"""Snapshot exact inputs, run the freeze under the exact private wrapper, then seal its result."""
import hashlib,json,pathlib,runpy,subprocess,sys
PLAN=pathlib.Path(__file__).resolve().parent;REPO=PLAN.parents[2];Q=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(mode=0o700)
assert out.is_relative_to(Q);definitions=runpy.run_path(str(PLAN/'task-17.3-evidence-validate.py'));sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for directory in ['inputs','inputs/current','inputs/baseline']:(out/directory).mkdir(mode=0o700)
current=[];baseline=[]
for name in definitions['CURRENT_DRIVERS']:
    target=out/'inputs/current'/name;target.write_bytes((PLAN/name).read_bytes());current.append({'name':name,'sha256':sha(target)})
oldfreeze=json.loads((Q/'fix1/previous-freeze/freeze.json').read_text())
for name in definitions['BASELINE_DRIVERS']:
    data=subprocess.check_output(['git','show','b5b32c2d9e5a3eb2cdc17f6685ce4573b65da4ee:.superpowers/sdd/2026-11-04-ocean-platform/'+name],cwd=REPO);target=out/'inputs/baseline'/name;target.write_bytes(data);assert sha(target)==oldfreeze['qualificationScripts'][name];baseline.append({'name':name,'sha256':sha(target)})
runner=out/'inputs/run-private.py';runner.write_bytes((PLAN/'run-private.py').read_bytes());assert runner.read_bytes()==(PLAN/'task-17.3-run-private.py').read_bytes()
(out/'inputs/reproduce.md').write_bytes((PLAN/'task-17.3-reproduce.md').read_bytes())
provenance={'artifactSourceRevision':'ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a','baselineEvidenceCommit':'b5b32c2d9e5a3eb2cdc17f6685ce4573b65da4ee','originalSharedRunner':{'path':str(PLAN/'run-private.py'),'sha256':sha(runner)},'reproducibleCommittedRunner':'task-17.3-run-private.py','baseline':baseline,'current':current}
(out/'inputs/provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
argv=['python3',str(runner),'python3',str(out/'inputs/current/task-17.3-freeze-evidence.py'),str(Q),str(out)]
call={'argv':argv,'artifactRoot':str(Q),'freezeDirectory':str(out),'cwd':str(REPO),'wrapperArgv':[sys.executable,*sys.argv],'envPolicy':'exact snapshotted private runner; no parent environment dumped'};(out/'invocation.json').write_text(json.dumps(call,indent=2)+'\n')
result=subprocess.run(argv,cwd=REPO,capture_output=True)
(out/'stdout.log').write_bytes(result.stdout);(out/'stderr.log').write_bytes(result.stderr)
seal={'format':1,'exit':result.returncode,'files':{name:{'sha256':sha(out/name),'bytes':(out/name).stat().st_size} for name in ['invocation.json','stdout.log','stderr.log']+(['evidence-inventory.json'] if (out/'evidence-inventory.json').exists() else [])}}
(out/'seal.json').write_text(json.dumps(seal,indent=2)+'\n')
print(json.dumps({'exit':result.returncode,'seal':str(out/'seal.json'),'rawSealSha256':sha(out/'seal.json'),'rawInventorySha256':sha(out/'evidence-inventory.json') if (out/'evidence-inventory.json').exists() else None},indent=2));sys.stdout.flush()
if result.returncode:sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
