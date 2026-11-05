"""One bounded owned scope: capture ownership before admitting the resistant fork."""
import ctypes,importlib.util,json,os,pathlib,re,secrets,subprocess,time
P=pathlib.Path(__file__).resolve().parent

def helper(name):
    spec=importlib.util.spec_from_file_location(name,P/('task-17.4-'+name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
scope=helper('scope');process=helper('process')
def read_record(path):
    v=json.loads(path.read_text())
    if type(v.get('pid'))is not int or v['pid']<=0 or not isinstance(v.get('starttime'),str)or not v['starttime'].isdecimal():raise ValueError('invalid fixture identity')
    return v

def launch(root,unit):
    command=['systemd-run','--user','--scope','--unit='+unit,'-p','MemoryMax=64M','-p','MemorySwapMax=0','-p','TasksMax=16','-p','CPUQuota=100%','env','-i','PATH=/usr/bin','LANG=C.UTF-8','python3',str(P/'task-17.4-scope-pilot.py'),str(root)]
    with(root/'command.json').open('x')as out:json.dump(command,out)
    with(root/'launcher.log').open('x')as log:return subprocess.Popen(command,stdout=log,stderr=log,close_fds=True)

def run_case(root,label,body):
    if not re.fullmatch('[a-z0-9_-]{1,24}',label):raise ValueError('invalid fixture label')
    root=pathlib.Path(root);root.mkdir(mode=0o700);ctypes.CDLL(None).prctl(36,1,0,0,0)
    unit='ocean-17-4-fix2-'+label+'-'+str(os.getpid())+'-'+secrets.token_hex(4)+'.scope'
    cg=pathlib.Path(f'/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice')/unit
    proof={'unit':unit,'admitted':False,'scopeGone':None,'error':None};handle=None;child=None;known=[];original=None;deadline=time.monotonic()+12
    try:
        child=launch(root,unit)
        while not(root/'ready.json').exists():
            if child.poll()is not None or time.monotonic()+7>deadline:raise RuntimeError('pilot readiness unavailable')
            time.sleep(.02)
        ready=read_record(root/'ready.json');known.append((ready['pid'],ready['starttime']))
        handle=scope.capture(unit,cg);proof['ownership']=handle;proof['ownershipVerifiedAt']=time.monotonic()
        with(root/'admit').open('x')as out:out.write('owned scope verified\n')
        proof['admitted']=True
        while not(root/'orphan.json').exists():
            if time.monotonic()+3>deadline:raise RuntimeError('orphan publication unavailable')
            time.sleep(.02)
        orphan=read_record(root/'orphan.json');known.append((orphan['pid'],orphan['starttime']));proof['orphan']=orphan
        proof['launcherExit']=child.wait(timeout=2);proof['populatedAfterLauncher']=scope.observe(handle);body(proof,handle)
    except Exception as error:original=error;proof['error']={'type':type(error).__name__,'message':str(error)}
    finally:
        try:proof['cleanup']=scope.retire(handle,term_seconds=.2,kill_seconds=2)if handle is not None else{'confirmed':False,'signals':[],'errors':['ownership unavailable; admission withheld']}
        except Exception as error:
            proof['cleanup']={'confirmed':False,'signals':[],'errors':[{'type':type(error).__name__,'message':str(error)}]}
            if original is None:original=error;proof['error']={'type':type(error).__name__,'message':str(error)}
        if child is not None:
            try:proof['reapedLauncherExit']=child.wait(timeout=max(.01,min(8,deadline-time.monotonic())))
            except subprocess.TimeoutExpired:proof['launcherReapUnavailable']=True
        reaped=[]
        while known and time.monotonic()<deadline:
            for pid,start in known:
                try:
                    got,_=os.waitpid(pid,os.WNOHANG)
                    if got:reaped.append(pid)
                except ChildProcessError:pass
            state=process.check(known)
            if state['confirmedGone']:break
            time.sleep(.02)
        if child is not None:
            try:proof['reapedLauncherExit']=child.wait(timeout=max(.01,min(2,deadline-time.monotonic())))
            except subprocess.TimeoutExpired:proof['launcherReapUnavailable']=True
        proof['reapedPids']=sorted(set(reaped));proof['pidIdentityCheck']=process.check(known)
        if handle is not None:
            try:
                observed=scope.observe(handle);proof['scopeGone']=observed['gone'];proof['scopeEmpty']=observed['gone']or(not observed['populated']and not observed['procs']);proof['scopeObservation']=observed
            except Exception as error:proof['scopeObservationUnavailable']=type(error).__name__
        with(root/'proof.json').open('x')as out:json.dump(proof,out,indent=2);out.write('\n')
    return {**proof,'originalError':original}
