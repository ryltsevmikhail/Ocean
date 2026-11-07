"""Focused gates with a private fresh invocation directory and exclusive records."""
import ast,importlib.util,json,os,pathlib,re,subprocess,sys,time
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])

def secure_module():
    spec=importlib.util.spec_from_file_location('private_output',P/'task-17.4-private-output.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def prepare(label,root):
    if not isinstance(label,str)or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,47}',label):raise ValueError('invalid run label')
    root=pathlib.Path(root);secure=secure_module();held=secure.root_fd(root)
    try:
        try:os.mkdir('runs',0o700,dir_fd=held)
        except FileExistsError:pass
        runs=secure.descend(held,['runs'])
        try:os.mkdir(label,0o700,dir_fd=runs);fd=secure.descend(runs,[label])
        finally:os.close(runs)
    finally:os.close(held)
    return root/'runs'/label,fd

def run(label,root,commands=None,syntax=None):
    path,fd=prepare(label,root);secure=secure_module();ledger=[];failure=None;syntax_result=[]
    if commands is None:
        commands=[]
        for name,private in [('fix2-regression-test',True),('fix2-controls-test',True),('identity-test',True),('resource-test',True),('fix1-integration-test',True),('scope-test',False)]:
            cmd=['python3',str(P/('task-17.4-'+name+'.py'))]
            if private:cmd=['python3',str(P/'run-private.py'),'env','OCEAN_QA_FIX_RUN='+str(path),*cmd]
            commands.append((name,cmd))
    if syntax is None:syntax=sorted(P.glob('task-17.4-*.py'))
    try:
        for name,command in commands:
            if not re.fullmatch('[a-z0-9_-]+',name):raise ValueError('invalid command label')
            started=time.monotonic();entry={'name':name,'argv':command,'cwd':str(pathlib.Path.cwd())}
            logfd=os.open(name+'.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
            with os.fdopen(logfd,'w')as log:
                try:r=subprocess.run(command,stdout=log,stderr=log,env={**os.environ,'OCEAN_QA_FIX_RUN':str(path)},timeout=30,close_fds=True);entry['exit']=r.returncode
                except subprocess.TimeoutExpired as error:entry.update(exit=None,error=type(error).__name__)
            entry['seconds']=time.monotonic()-started;ledger.append(entry)
            if entry['exit']!=0:raise RuntimeError('focused test failed: '+name)
        for source in syntax:
            ast.parse(source.read_text());lines=len(source.read_text().splitlines())
            if lines>300:raise ValueError('physical source line limit')
            syntax_result.append({'path':str(source),'lines':lines,'astParseExit':0})
        secure.publish(fd,'syntax.json',(json.dumps(syntax_result,indent=2)+'\n').encode())
    except Exception as error:failure={'type':type(error).__name__,'message':str(error)}
    finally:
        try:secure.publish(fd,'commands.json',(json.dumps({'commands':ledger,'failure':failure},indent=2)+'\n').encode())
        finally:os.close(fd)
    return {'ok':failure is None,'path':str(path),'tests':len(ledger),'syntaxFiles':len(syntax_result),'failure':failure}

if __name__=='__main__':
    if len(sys.argv)!=2:raise ValueError('one constrained fresh run label required')
    result=run(sys.argv[1],Q/'fix2');print(json.dumps(result,indent=2));sys.exit(0 if result['ok']else 1)
