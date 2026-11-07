"""Tri-state, publication, gate and admission safety controls without real children."""
import copy,errno,importlib.util,json,os,pathlib,subprocess,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,P/('task-17.4-'+name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class Controls(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(os.environ['OCEAN_QA_FIX_RUN'])/self._testMethodName;self.root.mkdir(mode=0o700)
    def test_process_live_absent_reused_parse_and_io_states(self):
        m=load('process');text=pathlib.Path('/proc/self/stat').read_text();start=text.rsplit(')',1)[1].split()[19]
        self.assertEqual(m.observe(os.getpid(),start)['state'],'present')
        with patch.object(pathlib.Path,'read_text',return_value=text):self.assertEqual(m.observe(os.getpid(),'1')['state'],'gone')
        for error,want in [(FileNotFoundError(errno.ENOENT,'gone'),'gone'),(ProcessLookupError(errno.ESRCH,'gone'),'gone'),(PermissionError(errno.EACCES,'denied'),'unavailable'),(OSError(errno.EIO,'io'),'unavailable')]:
            with patch.object(pathlib.Path,'read_text',side_effect=error):self.assertEqual(m.observe(123,'1')['state'],want)
        self.assertEqual(m.observe(os.getpid(),'0001')['state'],'unavailable')
        with patch.object(pathlib.Path,'read_text',return_value='broken'):self.assertEqual(m.observe(123,'1')['state'],'unavailable')
    def test_unrelated_proc_status_failure_does_not_mean_gone(self):
        m=load('process');real=pathlib.Path.read_text;start=pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
        def read(path,*args,**kwargs):
            if path.name!='stat':raise PermissionError('unrelated field denied')
            return real(path,*args,**kwargs)
        with patch.object(pathlib.Path,'read_text',read):self.assertEqual(m.observe(os.getpid(),start)['state'],'present')
        self.assertFalse(m.check([])['confirmedGone'])
    def test_finalizer_timeout_still_checks_and_records_original_error(self):
        m=load('finalize');original=RuntimeError('original work error');record={'error':str(original)};calls=[]
        class Launcher:
            def wait(self,timeout):calls.append(('wait',timeout));return 0
        def retire(_):raise subprocess.TimeoutExpired(['systemctl','kill'],3)
        def check(_):calls.append(('identity',None));return {'confirmedGone':False,'observations':[{'state':'unavailable'}]}
        returned=m.finish(record,{},Launcher(),[(123,'1')],retire,check,original)
        self.assertIs(returned,original);self.assertEqual(record['error'],str(original));self.assertFalse(record['scopeRetirement']['confirmed']);self.assertFalse(record['pidIdentityCheck']['confirmedGone']);self.assertEqual(calls,[('wait',3),('identity',None)])
        with(self.root/'failure-ledger.json').open('x')as out:json.dump(record,out)
        self.assertEqual(json.loads((self.root/'failure-ledger.json').read_text())['scopeRetirement']['errors'][0]['type'],'TimeoutExpired')
    def test_gate_rejects_labels_and_collisions_before_effects(self):
        m=load('fix1-gates')
        with patch.object(m.subprocess,'run')as effect:
            for label in ['../outside','/absolute','a/b','','A','x'*49]:
                with self.assertRaises(ValueError):m.run(label,self.root,commands=[],syntax=[])
            self.assertFalse(effect.called)
        first=m.run('fresh',self.root,commands=[],syntax=[]);self.assertTrue(first['ok']);before=(pathlib.Path(first['path'])/'syntax.json').read_bytes()
        with patch.object(m.subprocess,'run')as effect:
            with self.assertRaises(FileExistsError):m.run('fresh',self.root,commands=[],syntax=[])
            self.assertFalse(effect.called)
        second=m.run('different',self.root,commands=[],syntax=[]);self.assertTrue(second['ok']);self.assertEqual((pathlib.Path(first['path'])/'syntax.json').read_bytes(),before)
    def test_gate_failure_publishes_ledger_exclusively(self):
        m=load('fix1-gates')
        with patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired(['mock'],30)):
            result=m.run('timeout',self.root,commands=[('mock',['mock'])],syntax=[])
        self.assertFalse(result['ok']);record=json.loads((pathlib.Path(result['path'])/'commands.json').read_text());self.assertEqual(record['commands'][0]['error'],'TimeoutExpired');self.assertFalse((pathlib.Path(result['path'])/'syntax.json').exists())
    def test_lookup_failure_withholds_admission_and_has_bounded_wait(self):
        m=load('orphan-fixture');waits=[]
        class Launcher:
            def poll(self):return 0
            def wait(self,timeout):waits.append(timeout);return 0
        def launch(root,unit):(root/'ready.json').write_text(json.dumps({'pid':2147483647,'starttime':'1'}));return Launcher()
        with patch.object(m,'launch',side_effect=launch),patch.object(m.scope,'capture',side_effect=subprocess.TimeoutExpired(['systemctl','show'],2)):
            result=m.run_case(self.root/'case','lookup',lambda *_:self.fail('orphan admitted'))
        self.assertFalse(result['admitted']);self.assertIsNone(result['scopeGone']);self.assertFalse(result['cleanup']['confirmed']);self.assertFalse((self.root/'case/admit').exists());self.assertTrue(waits and all(0<t<=8 for t in waits));self.assertIsInstance(result['originalError'],subprocess.TimeoutExpired)
    def test_identity_compatible_alias_and_reuse_but_not_same_time(self):
        m=load('identities');q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);rows=[json.loads(x)for x in(q/'fix2/inputs/offline-acceptance4/samples.jsonl').read_text().splitlines()];host={'uid':1000,'CapEff':'0000000000000000','CapBnd':'000001ffffffffff','NoNewPrivs':'0'}
        validate=lambda v:m.validate(v,'native-offline','net:[4026532987]','net:[4026531833]',host)
        alias=copy.deepcopy(rows)
        for row in alias:
            for p in row['processes']:
                if p['name']=='node-MainThread':p['name']='node'
        self.assertTrue(validate(alias)['ok'])
        p=copy.deepcopy(next(p for r in rows for p in r['processes']if p['name']=='node-MainThread'));reused=copy.deepcopy(p);reused['starttime']=str(int(p['starttime'])+100)
        self.assertTrue(validate(rows+[{'processes':[reused]}])['ok']);self.assertFalse(validate(rows+[{'processes':[p,reused]}])['ok'])
        noncanonical=copy.deepcopy(p);noncanonical['starttime']='0'+p['starttime'];self.assertFalse(validate(rows+[{'processes':[noncanonical]}])['ok'])
if __name__=='__main__':unittest.main(verbosity=2)
