"""Focused QA correction gates; only the scope control uses the host user manager."""
import ast,json,pathlib,subprocess,time,sys
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix1';ledger=[];label=sys.argv[1]if len(sys.argv)>1 else 'final2'
for name,private in [('identity-test',True),('scope-test',False),('resource-test',True),('fix1-integration-test',True)]:
    command=['python3',str(P/('task-17.4-'+name+'.py'))]
    if private:command=['python3',str(P/'run-private.py'),*command]
    started=time.monotonic()
    with (F/'logs'/(label+'-'+name+'.log')).open('x')as log:r=subprocess.run(command,stdout=log,stderr=log,timeout=30,close_fds=True)
    ledger.append({'argv':command,'cwd':str(pathlib.Path.cwd()),'exit':r.returncode,'seconds':time.monotonic()-started});(F/(label+'-commands.json')).write_text(json.dumps(ledger,indent=2)+'\n');print(json.dumps(ledger[-1]),flush=True);assert r.returncode==0,name
files=['identities','identity-test','scope','scope-test','resources','resource-test','supervise','freeze','fix1-integration-test','fix1-gates','fix1-freeze']
syntax=[]
for name in files:
    p=P/('task-17.4-'+name+'.py');ast.parse(p.read_text());lines=len(p.read_text().splitlines());assert lines<=300;syntax.append({'path':str(p),'lines':lines,'astParseExit':0})
(F/'syntax.json').write_text(json.dumps(syntax,indent=2)+'\n');print(json.dumps({'pythonSyntaxPass':len(syntax),'maximumLines':max(x['lines']for x in syntax)}))
