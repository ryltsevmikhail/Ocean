"""Round3 copied/mocked/read-only-PID checks, explicitly excluding scope execution."""
import importlib.util,json,pathlib,sys
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
if len(sys.argv)!=2:raise ValueError('one fresh constrained label required')
spec=importlib.util.spec_from_file_location('gates',P/'task-17.4-fix1-gates.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
label=sys.argv[1];root=Q/'fix3';path=root/'runs'/label
commands=[(name,['python3',str(P/'run-private.py'),'env','OCEAN_QA_FIX_RUN='+str(path),'python3',str(P/('task-17.4-'+name+'.py'))])for name in ['fix3-test','fix2-regression-test','fix2-controls-test','identity-test','resource-test','fix1-integration-test']]
result=m.run(label,root,commands=commands);print(json.dumps(result,indent=2));sys.exit(0 if result['ok']else 1)
