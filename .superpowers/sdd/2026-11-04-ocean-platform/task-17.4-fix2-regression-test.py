"""Focused copied/mocked review counterexamples, never models or credentials."""
import ast,copy,errno,importlib.util,io,json,os,pathlib,subprocess,sys,unittest,contextlib
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix2';LEGACY='--legacy' in sys.argv
if LEGACY:sys.argv.remove('--legacy')
def load(name):
 path=F/'inputs'/('legacy-'+name+'.py')if LEGACY else P/('task-17.4-'+name+'.py');spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def definition(name,function,env):
 tree=ast.parse((F/'inputs'/('legacy-'+name+'.py')).read_text());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name==function);exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'legacy-actual-definition','exec'),env);return env[function]
HOST={'uid':1000,'CapEff':'0000000000000000','CapBnd':'000001ffffffffff','NoNewPrivs':'0'}
class Regression(unittest.TestCase):
 def setUp(self):
  self.root=pathlib.Path(os.environ.get('OCEAN_QA_FIX_RUN',str(F/'runs')))/('regression-'+str(os.getpid())+'-'+self._testMethodName);self.root.mkdir(mode=0o700)
 def offline(self):return [json.loads(x)for x in(F/'inputs/offline-acceptance4/samples.jsonl').read_text().splitlines()]
 def valid(self,rows):return load('identities').validate(rows,'native-offline','net:[4026532987]','net:[4026531833]',HOST)
 def test_i1_collapsed_node_identities_refused(self):
  rows=self.offline()
  for row in rows:
   for p in row['processes']:
    if p['name']in {'node','node-MainThread'}:p.update(pid=999999,starttime='12345')
  self.assertFalse(self.valid(rows)['ok'])
 def test_i1_same_identity_role_contradiction_refused(self):
  rows=self.offline();node=next(p for r in rows for p in r['processes']if p['name']=='node-MainThread'and '--input-type=module'in p['argv']);fake=copy.deepcopy(node);fake['argv']='/runtime/node /product/launch.js init --json ';rows[0]['processes']=[copy.deepcopy(node),fake,*rows[0]['processes']]
  self.assertFalse(self.valid(rows)['ok'])
 def test_i1_cross_observation_argv_contradiction_refused(self):
  rows=self.offline();node=next(p for r in rows for p in r['processes']if p['name']=='node-MainThread'and '--input-type=module'in p['argv']);fake=copy.deepcopy(node);fake['argv']+=' --unexpected-role-mutation';rows.append({'processes':[fake]});self.assertFalse(self.valid(rows)['ok'])
 def test_i2_proc_denied_is_unavailable_not_gone(self):
  if LEGACY:
   proc=definition('supervise','proc',{'pathlib':pathlib,'os':os})
   with patch.object(pathlib.Path,'read_text',side_effect=PermissionError(errno.EACCES,'denied')):state='gone'if proc(os.getpid())is None else'present'
  else:
   m=load('process')
   with patch.object(pathlib.Path,'read_text',side_effect=PermissionError(errno.EACCES,'denied')):state=m.observe(os.getpid(),'1')['state']
  self.assertEqual(state,'unavailable')
 def test_i3_middle_ancestor_swap_cannot_escape(self):
  module=load('resources');allowed=self.root/'fix1';allowed.mkdir(mode=0o700);middle=allowed/'middle';middle.mkdir(mode=0o700);(middle/'leaf').mkdir(mode=0o700);outside=self.root/'outside';outside.mkdir(mode=0o700);(outside/'leaf').mkdir(mode=0o700);target=middle/'leaf/summary.json';real=os.open;changed=False
  def swap(name,flags,*args,**kw):
   nonlocal changed
   if not changed and flags&os.O_DIRECTORY and (pathlib.Path(name)==middle/'leaf'or(str(name)=='middle'and kw.get('dir_fd')is not None)):
    middle.rename(allowed/'saved');middle.symlink_to(outside,target_is_directory=True);changed=True
   return real(name,flags,*args,**kw)
  try:
   with patch.object(module.os,'open',side_effect=swap):module.publish(self.root,target)
  except(OSError,ValueError):pass
  self.assertTrue(changed);self.assertFalse((outside/'leaf/summary.json').exists())
 def test_n3_manager_show_timeout_is_structured(self):
  module=load('scope')
  with patch.object(module,'verify',side_effect=subprocess.TimeoutExpired(['systemctl','show'],2)):
   try:result=module.retire({'unit':'owned'},term_seconds=0,kill_seconds=0,observe=lambda _: {'gone':False,'populated':True,'procs':[123]})
   except subprocess.TimeoutExpired:self.fail('manager timeout escaped retirement')
  self.assertFalse(result['confirmed']);self.assertTrue(result['errors'])
 def test_n3_manager_kill_timeout_is_structured(self):
  module=load('scope')
  with patch.object(module,'verify',return_value=pathlib.Path('/not-used')),patch.object(module.subprocess,'run',side_effect=subprocess.TimeoutExpired(['systemctl','kill'],3)):
   try:result=module.retire({'unit':'owned'},term_seconds=0,kill_seconds=0,observe=lambda _:{'gone':False,'populated':True,'procs':[123]})
   except subprocess.TimeoutExpired:self.fail('manager timeout escaped retirement')
  self.assertFalse(result['confirmed']);self.assertTrue(result['errors'])
 def test_n1_partial_admission_never_certifies_missing_handle(self):
  if LEGACY:
   class Launcher:
    returncode=0
    def poll(self):return 0
    def wait(self,timeout=None):return 0
   def launch(*args,**kwargs):
    roots=list(self.root.glob('scope-*'));(roots[0]/'orphan.json').write_text('');return Launcher()
   env={'F':self.root,'legacy':False,'os':os,'pathlib':pathlib,'json':json,'subprocess':subprocess,'time':__import__('time'),'wait':lambda *_:True,'properties':lambda _:self.fail('no verified ownership acquired'),'identity':lambda _:None}
   fixture=definition('scope-test','fixture',env)
   with patch.object(subprocess,'Popen',side_effect=launch):
    with self.assertRaises(json.JSONDecodeError):fixture('partial',lambda *_:None)
   proof=json.loads(next(self.root.glob('scope-*/proof.json')).read_text());self.assertFalse(proof['scopeGone'])
  else:
   module=load('orphan-fixture')
   class Launcher:
    def poll(self):return 0
    def wait(self,timeout=None):return 0
   def launch(root,unit):(root/'ready.json').write_text('');return Launcher()
   with patch.object(module,'launch',side_effect=launch),patch.object(module.scope,'capture',side_effect=OSError('manager unavailable')):proof=module.run_case(self.root/'case','partial',lambda *_:None)
   self.assertFalse(proof['cleanup']['confirmed']);self.assertFalse(proof['admitted']);self.assertTrue(proof['error']);self.assertIsNone(proof['scopeGone'])
 def test_n2_fresh_label_never_rewrites_shared_syntax(self):
  if LEGACY:
   source=self.root/'source';source.mkdir();dummy=self.root/'dummy';dummy.mkdir();old=dummy/'fix1';old.mkdir();(old/'logs').mkdir();sealed=old/'syntax.json';sealed.write_bytes(b'old-sealed-syntax');(source/'task-17.4-location.json').write_text(json.dumps({'root':str(dummy)}));code=(F/'inputs/legacy-fix1-gates.py').read_text();names=['identities','identity-test','scope','scope-test','resources','resource-test','supervise','freeze','fix1-integration-test','fix1-gates','fix1-freeze']
   for name in names:(source/('task-17.4-'+name+'.py')).write_text('pass\n')
   with patch.object(sys,'argv',['legacy','fresh']),patch.object(subprocess,'run',return_value=subprocess.CompletedProcess([],0)),contextlib.redirect_stdout(io.StringIO()):exec(compile(code,'legacy-driver','exec'),{'__file__':str(source/'driver.py')})
   self.assertEqual(sealed.read_bytes(),b'old-sealed-syntax')
  else:
   m=load('fix1-gates');old=self.root/'syntax.json';old.write_bytes(b'old-sealed-syntax');m.run('fresh',self.root,commands=[],syntax=[]);self.assertEqual(old.read_bytes(),b'old-sealed-syntax')
if __name__=='__main__':unittest.main(verbosity=2)
