"""Focused owner failure-path tests; outer supervisor owns and bounds every fake child."""
import ctypes,json,os,pathlib,signal,subprocess,sys,tempfile,time,unittest
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0  # Subreap only this test process descendants.
PLAN=pathlib.Path(__file__).resolve().parent
ROOT=pathlib.Path(sys.argv[1]);LEGACY='--legacy' in sys.argv;sys.argv=[sys.argv[0]]
def stat(pid):
    try:
        raw=pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
        return {'state':raw[0],'group':int(raw[2]),'session':int(raw[3]),'start':raw[19]}
    except FileNotFoundError:return None
class Cleanup(unittest.TestCase):
    def run_case(self,mode):
        root=pathlib.Path(tempfile.mkdtemp(prefix='owner-',dir=ROOT));pidfile=root/'pid.json'
        fake=root/'owner.cjs';fake.write_text("const fs=require('node:fs');fs.writeFileSync(process.env.FAKE_PID,JSON.stringify({pid:process.pid,start:fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ')[19]}));process.on('SIGTERM',()=>{});"+("console.log(JSON.stringify({state:'ready'}));" if mode!='never-ready' else '')+"setInterval(()=>{},20);\n")
        if LEGACY:
            original=subprocess.check_output(['git','show','b5b32c2d9e5a3eb2cdc17f6685ce4573b65da4ee:.superpowers/sdd/2026-11-04-ocean-platform/task-17.3-rebind-probe.txt'],text=True)
            block=original.split('let owner,closed,client;const hosts=[];')[1].split('const descriptors=')[0].replace('i<500','i<5')
            code="import {spawn} from 'node:child_process';import {once} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';let owner,closed,client;const hosts=[];const hook='',entry=process.env.FAKE_ENTRY;const connectLocalRuntime=async()=>{throw Error('synthetic-connect-refused')};"+block+"try{await start('synthetic')}finally{await stop()}"
        else:
            helper=(PLAN/'task-17.3-owner-lifecycle.txt').read_text()
            code="import fs from 'node:fs';const {QualificationOwner,withQualificationOwner}=await import('data:text/javascript,'+encodeURIComponent(process.env.OWNER_HELPER));const owner=new QualificationOwner({startupMs:120,graceMs:100,termMs:100,killMs:1000});try{await withQualificationOwner(owner,async()=>{await owner.start([process.env.FAKE_ENTRY],{env:process.env,connect:async()=>{if(process.env.CASE==='connect-refusal')throw Error('synthetic-connect-refused');return {stop:async()=>({outcome:'complete'}),close(){}}}});await owner.stop();},record=>fs.writeFileSync(process.env.RESULT,JSON.stringify(record)));}catch(e){process.exitCode=7;}"

        env=dict(os.environ,FAKE_PID=str(pidfile),FAKE_ENTRY=str(fake),CASE=mode,RESULT=str(root/'result.json'),OWNER_HELPER='' if LEGACY else helper)
        command=['node','--input-type=module','-e',code];start=time.monotonic();p=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);outer=stat(p.pid);timed_out=False;original_pid=None
        try:
            try:out,err=p.communicate(timeout=2.5)
            except subprocess.TimeoutExpired:
                timed_out=True;os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate(timeout=2)
            if pidfile.exists():original_pid=json.loads(pidfile.read_text())['pid']
            result=json.loads((root/'result.json').read_text()) if (root/'result.json').exists() else None
            proof={'case':mode,'legacy':LEGACY,'outerPid':p.pid,'outerIdentity':outer,'childPid':original_pid,'exit':p.returncode,'elapsedMs':round((time.monotonic()-start)*1000),'outerTimeout':timed_out,'stdout':out,'stderr':err,'result':result}
            (root/'command-proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof),flush=True)
            self.assertFalse(timed_out,'owner startup/cleanup must finish before outer supervisor deadline')
            self.assertEqual(p.returncode,7)
            self.assertEqual(result['failure'],{'never-ready':'owner_startup_timeout','connect-refusal':'synthetic-connect-refused','nonclosing':'owner_close_timeout'}[mode])
            self.assertTrue(result['cleanup']['leaderReaped']);self.assertTrue(result['cleanup']['groupGone'])
            self.assertIn('SIGKILL',result['cleanup']['signals'])
            self.assertIsNone(stat(original_pid),'recorded direct child must be reaped')
        finally:
            if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
            if pidfile.exists():
                saved=json.loads(pidfile.read_text());original_pid=saved['pid'];current=stat(original_pid)
                if current and current['start']==saved['start'] and current['group']==current['session'] and current['group'] in [p.pid,original_pid]:
                    try:os.killpg(current['group'],signal.SIGKILL)
                    except ProcessLookupError:pass
                deadline=time.monotonic()+2
                while time.monotonic()<deadline:
                    try:
                        waited,_=os.waitpid(original_pid,os.WNOHANG)
                        if waited:break
                    except ChildProcessError:break
                    time.sleep(.01)
                if stat(original_pid) is not None:raise AssertionError('outer supervisor failed to reap owned fake child')
    def test_startup_never_ready(self):self.run_case('never-ready')
    @unittest.skipIf(LEGACY,'legacy RED isolates mandatory never-ready case')
    def test_client_connect_refusal(self):self.run_case('connect-refusal')
    @unittest.skipIf(LEGACY,'legacy RED isolates mandatory never-ready case')
    def test_nonclosing_after_stop(self):self.run_case('nonclosing')
unittest.main()
