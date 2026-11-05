"""Real disposable orphan scope; independent outer cleanup reaps even legacy RED."""
import ctypes,importlib.util,json,os,pathlib,signal,subprocess,sys,time,unittest
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']);F=Q/'fix1';legacy='--legacy' in sys.argv
if legacy:sys.argv.remove('--legacy')
else:
 spec=importlib.util.spec_from_file_location('scope',P/'task-17.4-scope.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
ctypes.CDLL(None).prctl(36,1,0,0,0)
def properties(unit):
 r=subprocess.run(['systemctl','--user','show',unit,'--property=ControlGroup,InvocationID,Id'],capture_output=True,text=True,timeout=2);assert r.returncode==0,r.stderr
 return dict(line.split('=',1)for line in r.stdout.splitlines())
def wait(predicate,seconds):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if predicate():return True
  time.sleep(.03)
 return False
def identity(pid):
 try:return pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[19]
 except OSError:return None
def fixture(label,body):
 root=F/('scope-'+label+('-red-' if legacy else '-green-')+str(os.getpid()));root.mkdir();unit='ocean-17-4-fix1-'+label+'-'+str(os.getpid())+'.scope';pidfile=root/'orphan.json'
 code="import os,signal,time,json,pathlib; pid=os.fork();\nif pid: os._exit(0)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN);p=pathlib.Path("+repr(str(pidfile))+");p.write_text(json.dumps({'pid':os.getpid(),'starttime':pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]}));\nwhile True: time.sleep(.05)\n"
 cmd=['systemd-run','--user','--scope','--unit='+unit,'-p','MemoryMax=64M','-p','MemorySwapMax=0','-p','TasksMax=16','-p','CPUQuota=100%','env','-i','PATH=/usr/bin','LANG=C.UTF-8','python3','-c',code]
 with (root/'launcher.log').open('x')as log:child=subprocess.Popen(cmd,stdout=log,stderr=log,close_fds=True)
 proof={'argv':cmd,'unit':unit};handle=None;orphan=None
 try:
  assert wait(pidfile.exists,4),'orphan not ready';orphan=json.loads(pidfile.read_text());props=properties(unit);cg=pathlib.Path('/sys/fs/cgroup'+props['ControlGroup']);handle={'unit':unit,'cgroup':str(cg),'invocation':props['InvocationID'],'dev':cg.stat().st_dev,'ino':cg.stat().st_ino,'uid':os.getuid()}
  child.wait(timeout=4);proof.update({'launcherExit':child.returncode,'orphan':orphan,'scope':handle,'populatedAfterLauncher':(cg/'cgroup.events').read_text()});assert child.returncode==0 and 'populated 1' in proof['populatedAfterLauncher']
  body(proof,handle)
 finally:
  # Safety supervisor never trusts the tested predicate or any bare PID for signalling.
  cg=pathlib.Path(handle['cgroup'])if handle else None
  try:populated=cg is not None and 'populated 1' in (cg/'cgroup.events').read_text()
  except FileNotFoundError:populated=False
  if populated:
   props=properties(unit);assert props['ControlGroup']==str(cg).removeprefix('/sys/fs/cgroup') and props['InvocationID']==handle['invocation'] and (cg.stat().st_dev,cg.stat().st_ino)==(handle['dev'],handle['ino'])
   proof['outerKillExit']=subprocess.run(['systemctl','--user','kill','--kill-whom=all','--signal=KILL',unit],capture_output=True,text=True,timeout=3).returncode
  if child.poll()is None:child.wait(timeout=4)
  if orphan:
   try:os.waitpid(orphan['pid'],0)
   except ChildProcessError:pass
   proof['pidStarttimeGone']=identity(orphan['pid'])!=orphan['starttime'];assert proof['pidStarttimeGone']
  proof['scopeGone']=wait(lambda:not handle or not pathlib.Path(handle['cgroup']).exists(),3);assert proof['scopeGone']
  (root/'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
class Scope(unittest.TestCase):
 def test_orphan_retired_after_launcher_exit(self):
  def body(proof,handle):
   if legacy:
    cg=pathlib.Path(handle['cgroup']);record={};source=(F/'inputs/legacy-supervise.py').read_text();start=source.index('for _ in range(30):');end=source.index("record['pidIdentitiesGone']",start)
    exec(source[start:end],{'cg':cg,'record':record,'time':time,'snapshot':lambda _:None});result={'confirmed':record['scopeGone'],'signals':[]}
   else:result=module.retire(handle,term_seconds=.2,kill_seconds=2)
   proof['retirement']=result;self.assertTrue(result['confirmed']);self.assertEqual([s['signal']for s in result['signals']],['TERM','KILL'])
  fixture('orphan',body)
 @unittest.skipIf(legacy,'new observation control')
 def test_failed_observation_is_not_cleanup(self):
  def body(proof,handle):
   def unavailable(_):raise OSError('synthetic cgroup observation unavailable')
   result=module.retire(handle,term_seconds=.1,kill_seconds=.2,observe=unavailable);proof['retirement']=result;self.assertFalse(result['confirmed']);self.assertTrue(result['errors']);self.assertEqual(result['signals'],[])
  fixture('observation',body)
 @unittest.skipIf(legacy,'new ownership control')
 def test_wrong_ownership_never_signals(self):
  def body(proof,handle):
   wrong=dict(handle,invocation='0'*32);result=module.retire(wrong,term_seconds=.1,kill_seconds=.2);proof['retirement']=result;self.assertFalse(result['confirmed']);self.assertEqual(result['signals'],[])
  fixture('ownership',body)
if __name__=='__main__':unittest.main(verbosity=2)
