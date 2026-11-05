"""Focused post-freeze controls on copied evidence only; never mutate sealed originals."""
import hashlib,json,pathlib,shutil,subprocess,sys,tempfile
seal=pathlib.Path(sys.argv[1]);expected=sys.argv[2];root=seal.parent
collector=seal/'inputs/task-17.4-freeze.py';runner=seal/'inputs/run-private.py'
def run(label,target,anchor,base):
    cmd=['python3',str(runner),'python3',str(collector),'verify',str(target),anchor,str(base)]
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=30,close_fds=True)
    return {'case':label,'argv':cmd,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
results=[run('actual',seal,expected,root)];assert results[0]['exit']==0
copy=pathlib.Path(tempfile.mkdtemp(prefix='validation-copy-',dir=root));copy.chmod(0o700)
try:
    inventory=json.loads((seal/'inventory.json').read_text())
    for name in inventory:
        dest=copy/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,dest);dest.chmod(inventory[name]['mode'])
    copiedSeal=copy/seal.name;copiedSeal.mkdir(exist_ok=True)
    for name in ['seal.json','inventory.json']:shutil.copyfile(seal/name,copiedSeal/name)
    proof=copy/'online-mixed/mixed-proof.json';original=proof.read_bytes();proof.write_bytes(original+b' ')
    result=run('copied mixed proof tamper',copiedSeal,expected,copy);assert result['exit']!=0;results.append(result);proof.write_bytes(original)
    altered=dict(inventory);del altered['online-mixed/mixed-proof.json'];(copiedSeal/'inventory.json').write_text(json.dumps(altered))
    sealRecord=json.loads((copiedSeal/'seal.json').read_text());sealRecord['inventorySha256']=hashlib.sha256((copiedSeal/'inventory.json').read_bytes()).hexdigest();(copiedSeal/'seal.json').write_text(json.dumps(sealRecord))
    anchor=hashlib.sha256((copiedSeal/'seal.json').read_bytes()).hexdigest()
    result=run('rehashed omission of required mixed proof',copiedSeal,anchor,copy);assert result['exit']!=0 and 'required evidence omitted' in result['stderr'];results.append(result)
finally:shutil.rmtree(copy)
output=root/'validation-final';output.mkdir(mode=0o700)
(output/'attestation.json').write_text(json.dumps({'seal':expected,'controlsPassed':3,'results':results,'copyRemoved':not copy.exists(),'freezeInvocation':json.loads((root/'final-freeze-invocation.json').read_text())},indent=2)+'\n')
print(json.dumps({'controlsPassed':3,'actualFilesVerified':len(inventory),'copyRemoved':not copy.exists()}))
