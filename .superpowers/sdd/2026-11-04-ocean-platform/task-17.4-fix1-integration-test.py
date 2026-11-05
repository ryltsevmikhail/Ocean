"""Execute actual supervisor postprocessing/gates on copied facts, never its launcher."""
import ast,copy,importlib.util,json,pathlib,sys,unittest
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix1'
spec=importlib.util.spec_from_file_location('identities',P/'task-17.4-identities.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
HOST={'uid':1000,'CapEff':'0000000000000000','CapBnd':'000001ffffffffff','NoNewPrivs':'0'}
source=(P/'task-17.4-supervise.py').read_text();tree=ast.parse(source)
post=next(n for n in ast.walk(tree) if isinstance(n,ast.If) and "(phase / 'network.json').exists()"==ast.unparse(n.test))
spec2=importlib.util.spec_from_file_location('finalize',P/'task-17.4-finalize.py');finalizer=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(finalizer)
exitNode=ast.parse('sys.exit(finalizeHelper.exit_code(record))').body[0]
freeze=ast.parse((P/'task-17.4-freeze.py').read_text());offline=next(n for n in freeze.body if isinstance(n,ast.If) and ast.unparse(n.test)=="mode == 'offline'")
guard=next(n for n in offline.body if isinstance(n,ast.Assert) and 'identityValidation' in ast.unparse(n))
def execute(node,env):exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'actual-helper-block','exec'),env)
class Integration(unittest.TestCase):
 def test_actual_supervisor_postprocess_offline_roles(self):
  record={};execute(post,{'phase':F/'inputs/offline-acceptance4','json':json,'record':record,'identityHelper':m,'policy':'native-offline','outerNamespace':'net:[4026531833]','outerSecurity':HOST})
  self.assertTrue(record['identityValidation']['ok']);self.assertEqual(len(record['identityValidation']['identities']),6)
 def test_actual_supervisor_postprocess_online_normal_policy(self):
  record={};execute(post,{'phase':F/'inputs/online-mixed','json':json,'record':record,'identityHelper':m,'policy':'mixed-online','outerNamespace':'net:[4026531833]','outerSecurity':HOST})
  self.assertTrue(record['identityValidation']['ok']);self.assertEqual(len(record['identityValidation']['identities']),4)
 def test_actual_freeze_refuses_legacy_boolean_only(self):
  supervisor={'exit':0,'scopeGone':True,'pidIdentitiesGone':True,'pidIdentityCheck':{'confirmedGone':True},'launcherReaped':True,'oomFree':True,'privateNetnsDifferent':True,'backendClientNamespacesMatch':True,'identityValidation':{'ok':False},'scopeRetirement':{'confirmed':True}}
  with self.assertRaises(AssertionError):execute(guard,{'supervisor':supervisor})
  supervisor['identityValidation']['ok']=True;execute(guard,{'supervisor':supervisor});supervisor['scopeRetirement']['confirmed']=False
  with self.assertRaises(AssertionError):execute(guard,{'supervisor':supervisor})
 def test_actual_exit_preserves_original_failure(self):
  class Exit:
   code=None
   def exit(self,code):self.code=code
  record={'exit':0,'scopeGone':True,'scopeEmpty':True,'pidIdentitiesGone':True,'pidIdentityCheck':{'confirmedGone':True},'launcherReaped':True,'oomFree':True,'scopeRetirement':{'confirmed':True},'identityValidation':{'ok':True}}
  target=Exit();execute(exitNode,{'record':record,'sys':target,'finalizeHelper':finalizer});self.assertEqual(target.code,0)
  record['pidIdentityCheck']['confirmedGone']=False;execute(exitNode,{'record':record,'sys':target,'finalizeHelper':finalizer});self.assertEqual(target.code,1)
  record['pidIdentityCheck']['confirmedGone']=True
  record['error']='original observation error';execute(exitNode,{'record':record,'sys':target,'finalizeHelper':finalizer});self.assertEqual(target.code,1);self.assertEqual(record['error'],'original observation error')
if __name__=='__main__':unittest.main(verbosity=2)
