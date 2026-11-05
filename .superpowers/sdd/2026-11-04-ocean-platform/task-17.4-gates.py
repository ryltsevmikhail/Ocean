"""Run exact root gates with private environment and retained command exits."""
import json,pathlib,subprocess,sys,time
P=pathlib.Path(__file__).resolve().parent;W=P.parents[2]
Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
commands=[('check',['pnpm','check']),('build',['pnpm','build']),('format',['pnpm','format:check']),('strict',['pnpm','typecheck:tests']),('lint',['pnpm','lint']),('process',['pnpm','exec','vitest','run','--config','vitest.process.config.ts',*[f'apps/cli/src/local-runtime/{name}-process.test.ts' for name in ['own-engine','lost-receipt','restart','broadcast','model-timeout','model-evidence','model-compatibility','model-recovery']]]),('bundle',['pnpm','--filter','@ocean/desktop','bundle'])]
ledger=[]
for name,args in commands:
    cmd=['python3',str(P/'run-private.py'),*args];started=time.time()
    with (Q/'logs'/('final-root-'+name+'.log')).open('x') as f:
        try:result=subprocess.run(cmd,cwd=W,stdout=f,stderr=f,timeout=600,close_fds=True);code=result.returncode
        except subprocess.TimeoutExpired:code='timeout';raise
    ledger.append({'name':name,'argv':cmd,'cwd':str(W),'exit':code,'seconds':time.time()-started})
    (Q/'final-gate-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
    print(json.dumps(ledger[-1]),flush=True)
