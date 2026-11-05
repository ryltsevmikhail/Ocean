"""Read/assert corrected driver and helper bytes before executing any installed qualification."""
import hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]);case=sys.argv[2];plan=pathlib.Path(__file__).resolve().parent;expected=json.loads((root/'fix2/checked-driver-inputs.json').read_text())
for name,digest in expected.items():assert hashlib.sha256((plan/name).read_bytes()).hexdigest()==digest,(name,'driver changed before effects')
source=(plan/'task-17.3-rebind-probe.txt').read_text();assert source.index('prepareProofOutput(artifact')<source.index('createRuntime({');assert "OCEAN_QA_REBIND_PROOF??'rebind-proof.json'" not in source
name='rebind-'+case+'-fix2-checked';env=dict(os.environ,OCEAN_QA_ARTIFACT=str(root),OCEAN_QA_REHEARSAL_NAME=name,OCEAN_QA_TTY_HELPER=str(plan/'task-17.3-tty-confirm.py'))
if case=='invalid':env['OCEAN_QA_REBIND_PROOF']='rebind-proof.json'
else:env.pop('OCEAN_QA_REBIND_PROOF',None)
print(json.dumps({'case':case,'rehearsal':name,'checkedInputs':expected,'argv':['node','--input-type=module'],'cwd':str(root/'prefix/lib/ocean/releases/1.1.0-rc.3')}),flush=True)
result=subprocess.run(['node','--input-type=module'],input=source,text=True,cwd=root/'prefix/lib/ocean/releases/1.1.0-rc.3',env=env)
if case=='invalid':assert not (root/name).exists(),'invalid destination created rehearsal effects'
print('CHECKED_REBIND_EXIT',result.returncode,flush=True);raise SystemExit(result.returncode)
