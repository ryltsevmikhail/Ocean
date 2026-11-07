"""Round3 exact identity/stat/caller-tail counterexamples; no scope or model launch."""
import ast,copy,contextlib,errno,importlib.util,io,json,os,pathlib,sys,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix3';LEGACY='--legacy'in sys.argv
if LEGACY:sys.argv.remove('--legacy')
HOST={'uid':1000,'CapEff':'0000000000000000','CapBnd':'000001ffffffffff','NoNewPrivs':'0'}
def source(name):return F/'inputs'/('legacy-'+name+'.py')if LEGACY else P/('task-17.4-'+name+'.py')
def load(name):
 spec=importlib.util.spec_from_file_location(name,source(name));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def rows(name='offline-acceptance4'):return[json.loads(x)for x in(F/'inputs'/name/'samples.jsonl').read_text().splitlines()]
def validate(value,online=False):return load('identities').validate(value,'mixed-online'if online else'native-offline','net:[4026531833]'if online else'net:[4026532987]','net:[4026531833]',HOST)
def caller(root,original,fail_snapshot=True):
 phase=root/'phase';phase.mkdir(mode=0o700);short=root/'short';short.mkdir(mode=0o700)
 (phase/'network.json').write_text((F/'inputs/offline-acceptance4/network.json').read_text());(phase/'samples.jsonl').write_text((F/'inputs/offline-acceptance4/samples.jsonl').read_text());(phase/'cgroup-final.json').write_text(json.dumps({'cgroup':{'memory.events':'oom 0\noom_kill 0\noom_group_kill 0'}}))
 text=source('supervise').read_text();tree=ast.parse(text);writer=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='write');tail=text[text.index('# Retirement follows actual population'):];calls=[]
 class Scope:
  def retire(self,_):return {'confirmed':False if original else True,'signals':[],'errors':[{'type':'TimeoutExpired','message':'manager kill timed out'}]if original else[]}
 class Process:
  def check(self,_):calls.append('identity');return {'confirmedGone':True,'observations':[{'state':'gone'}]}
 class Child:
  def wait(self,timeout):calls.append('wait');return 0
 class Group:
  def exists(self):return fail_snapshot
 def snapshot(_):calls.append('remaining-snapshot');raise UnicodeDecodeError('utf8',b'\xff',0,1,'secondary comm decode')
 record={'exit':0}
 if original:record['error']=str(original)
 env={'record':record,'scopeHandle':{},'child':Child(),'seen':{(123,'1'):{'pid':123,'starttime':'1'}},'cg':Group(),'snapshot':snapshot,'scopeHelper':Scope(),'processHelper':Process(),'finalizeHelper':load('finalize'),'identityHelper':load('identities'),'workError':original,'phase':phase,'short':short,'outerNamespace':'net:[4026531833]','outerSecurity':HOST,'policy':'native-offline','time':__import__('time'),'json':json,'sys':sys}
 exec(compile(ast.fix_missing_locations(ast.Module(body=[writer],type_ignores=[])),'actual-supervisor-writer','exec'),env)
 try:
  with contextlib.redirect_stdout(io.StringIO()):exec(compile(tail,'actual-supervisor-tail','exec'),env)
 except SystemExit as ended:status=ended.code
 except UnicodeDecodeError as error:raise AssertionError('secondary diagnostic escaped actual supervisor publication')from error
 else:raise AssertionError('actual supervisor did not return a status')
 return env,record,status,calls,json.loads((phase/'supervisor-result.json').read_text())
class Round3(unittest.TestCase):
 def setUp(self):
  self.root=pathlib.Path(os.environ.get('OCEAN_QA_FIX_RUN',str(F/'runs')))/('round3-'+str(os.getpid())+'-'+self._testMethodName);self.root.mkdir(mode=0o700)
 def duplicate(self,unknown_first=False,cross=False):
  value=rows();row=next(r for r in value if any(p['name']=='node-MainThread'for p in r['processes']));p=next(p for p in row['processes']if p['name']=='node-MainThread');fake={**p,'name':'sleep','argv':'sleep 999','netns':'net:[1]'}
  if cross:value.append({'processes':[fake]})
  elif unknown_first:row['processes'].insert(0,fake)
  else:row['processes'].append(fake)
  return value
 def test_recognized_identity_unrecognized_duplicate_refused(self):self.assertFalse(validate(self.duplicate())['ok'])
 def test_unrecognized_duplicate_first_refused(self):self.assertFalse(validate(self.duplicate(True))['ok'])
 def test_cross_observation_identity_contradiction_refused(self):self.assertFalse(validate(self.duplicate(cross=True))['ok'])
 def test_same_snapshot_recognized_pid_different_start_refused(self):
  value=self.duplicate();row=next(r for r in value if any(p['name']=='sleep'for p in r['processes']));fake=next(p for p in row['processes']if p['name']=='sleep');fake['starttime']=str(int(fake['starttime'])+1);self.assertFalse(validate(value)['ok'])
 def test_unrelated_helper_is_not_subject_to_node_policy(self):
  value=rows();value[0]['processes'].append({'pid':999999,'starttime':'1','name':'sleep','argv':'sleep 999','netns':'net:[1]','CapEff':None,'CapBnd':None,'NoNewPrivs':None});self.assertTrue(validate(value)['ok']);self.assertEqual(len(validate(value)['identities']),6);self.assertEqual(len(validate(rows('online-mixed'),True)['identities']),4)
 def stat(self):
  text=pathlib.Path('/proc/self/stat').read_text();pos=text.rfind(')');parts=text[pos+1:].split();return text[:pos+1],parts
 def test_padded_observed_same_tick_is_not_reuse(self):
  prefix,parts=self.stat();expected=parts[19];parts[19]='0'+expected;text=prefix+' '+' '.join(parts)+'\n'
  with patch.object(pathlib.Path,'read_text',return_value=text):result=load('process').check([(os.getpid(),expected)])
  self.assertFalse(result['confirmedGone']);self.assertIn(result['observations'][0]['state'],{'present','unavailable'})
 def test_observed_noncanonical_fields_are_unavailable(self):
  prefix,parts=self.stat();expected=parts[19]
  for token in ['0'+expected,'+'+expected,'0','١']:
   copy_parts=list(parts);copy_parts[19]=token
   with patch.object(pathlib.Path,'read_text',return_value=prefix+' '+' '.join(copy_parts)):self.assertEqual(load('process').observe(os.getpid(),expected)['state'],'unavailable')
 def test_current_process_readonly_is_present(self):
  _,parts=self.stat();self.assertEqual(load('process').observe(os.getpid(),parts[19])['state'],'present')
 def test_actual_caller_publishes_original_and_secondary_failure(self):
  original=UnicodeDecodeError('utf8',b'\xff',0,1,'original comm decode');env,record,status,calls,published=caller(self.root,original)
  self.assertIs(env['workError'],original);self.assertEqual(status,1);self.assertEqual(published['error'],str(original));self.assertEqual(published['originalErrorType'],'UnicodeDecodeError');self.assertEqual(published['scopeRetirement']['errors'][0]['type'],'TimeoutExpired');self.assertEqual(published['secondaryErrors'][0]['type'],'UnicodeDecodeError');self.assertIn('wait',calls);self.assertIn('identity',calls);self.assertIn('remaining-snapshot',calls)
 def test_actual_caller_secondary_without_primary_is_recorded(self):
  env,record,status,calls,published=caller(self.root,None);self.assertEqual(status,1);self.assertIsInstance(env['workError'],UnicodeDecodeError);self.assertEqual(published['secondaryErrors'][0]['type'],'UnicodeDecodeError');self.assertTrue(published['pidIdentityCheck']['confirmedGone'])
 def test_actual_healthy_caller_still_passes(self):
  env,record,status,calls,published=caller(self.root,None,False);self.assertEqual(status,0);self.assertNotIn('error',published);self.assertTrue(published['identityValidation']['ok'])
if __name__=='__main__':unittest.main(verbosity=2)
