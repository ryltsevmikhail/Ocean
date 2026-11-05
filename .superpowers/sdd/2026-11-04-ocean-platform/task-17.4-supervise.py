"""Owned native phase: clean environment, bounded cgroup, netns, samples and retirement."""
import json,os,pathlib,subprocess,sys,time,socket,signal,tempfile,traceback
P=pathlib.Path(__file__).resolve().parent
Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
FILES=['cpu.max','cpu.stat','memory.high','memory.max','memory.current','memory.peak','memory.swap.max','memory.swap.current','memory.swap.peak','memory.events','memory.swap.events','pids.max','pids.current','pids.events','cgroup.events','cgroup.procs']
def helper(name):
    import importlib.util
    spec=importlib.util.spec_from_file_location(name,P/('task-17.4-'+name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def write(path,value):
    with path.open('x') as f: json.dump(value,f,indent=2); f.write('\n')
def proc(pid):
    base=pathlib.Path('/proc')/str(pid)
    try:
        stat=(base/'stat').read_text().rsplit(')',1)[1].split()
        values={line.split(':')[0]:line.split(':',1)[1].strip() for line in (base/'status').read_text().splitlines()}
        try: pss=next(line.split(':',1)[1].strip() for line in (base/'smaps_rollup').read_text().splitlines() if line.startswith('Pss:'))
        except (OSError,StopIteration): pss=None
        return {'pid':pid,'starttime':stat[19],'name':values['Name'],'argv':(base/'cmdline').read_bytes().replace(b'\0',b' ').decode('utf8','replace'),'netns':os.readlink(base/'ns/net'),'CapEff':values.get('CapEff'),'CapBnd':values.get('CapBnd'),'NoNewPrivs':values.get('NoNewPrivs'),'VmRSS':values.get('VmRSS'),'VmHWM':values.get('VmHWM'),'VmSwap':values.get('VmSwap'),'Pss':pss}
    except OSError: return None
def snapshot(cg):
    result={'monotonic':time.monotonic(),'cgroup':{}}
    for n in FILES:
        try: result['cgroup'][n]=(cg/n).read_text().strip()
        except OSError: result['cgroup'][n]=None
    result['processes']=[value for pid in (result['cgroup'].get('cgroup.procs') or '').split() if (value:=proc(int(pid)))]
    return result
if sys.argv[1]=='inner':
    import ctypes,errno
    libc=ctypes.CDLL(None,use_errno=True)
    if sys.argv[5]=='offline':
        for capability in range(64):
            if capability!=13 and libc.prctl(24,capability,0,0,0)!=0 and ctypes.get_errno()!=errno.EINVAL:raise RuntimeError('bounding capability retirement failed')
        class Header(ctypes.Structure):_fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
        class Data(ctypes.Structure):_fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
        header=Header(0x20080522,0);data=(Data*2)(Data(1<<13,1<<13,1<<13),Data(0,0,0))
        assert libc.capset(ctypes.byref(header),ctypes.byref(data))==0
        assert libc.prctl(38,1,0,0,0)==0
    phase=pathlib.Path(sys.argv[2]); installed=pathlib.Path(sys.argv[3]); driver=pathlib.Path(sys.argv[4]); offline=sys.argv[5]=='offline'
    network={'namespace':os.readlink('/proc/self/ns/net'),'offline':offline,'routes':{}}
    if offline:
        links=json.loads(subprocess.check_output(['ip','-j','link'],text=True))
        if 'UP' not in links[0]['flags']:subprocess.run(['ip','link','set','lo','up'],check=True,close_fds=True)
    for name,args in [('links',['link']),('routes4',['route','show','table','all']),('routes6',['-6','route','show','table','all'])]:
        r=subprocess.run(['ip','-j',*args],capture_output=True,text=True,check=True,close_fds=True); network['routes'][name]=json.loads(r.stdout)
    if offline:
        assert [x['ifname'] for x in network['routes']['links']]==['lo']
        for name in ['routes4','routes6']:
            assert all(x.get('dev')=='lo' and x.get('dst')!='default' for x in network['routes'][name])
        network['egress']=[]
        for family,address in [(socket.AF_INET,('1.1.1.1',443)),(socket.AF_INET6,('2606:4700:4700::1111',443))]:
            with socket.socket(family,socket.SOCK_STREAM) as s:
                s.settimeout(2); started=time.monotonic()
                try: s.connect(address); raise RuntimeError('unexpected external route')
                except OSError as e: network['egress'].append({'address':address,'errno':e.errno,'seconds':time.monotonic()-started})
    write(phase/'network.json',network)
    if offline:
        caps={line.split(':')[0]:line.split(':',1)[1].strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('Cap')}
        write(phase/'filesystem-capabilities.json',{'mountinfo':pathlib.Path('/proc/self/mountinfo').read_text(),'capabilities':caps,'ancestorUIDs':{str(v):v.stat().st_uid for v in [pathlib.Path('/'),pathlib.Path('/home'),phase,pathlib.Path(os.environ['XDG_RUNTIME_DIR'])]}})
        assert int(caps['CapEff'],16)==1<<13 and not int(caps['CapBnd'],16)&(1<<21)
    env={k:os.environ[k] for k in ['PATH','HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','TMPDIR','LANG']}
    env.update({'OLLAMA_HOST':'127.0.0.1:11474','OLLAMA_MODELS':str(Q/'models'),'OLLAMA_NO_CLOUD':'1','OLLAMA_NOPRUNE':'1','OLLAMA_MAX_LOADED_MODELS':'1','OLLAMA_NUM_PARALLEL':'1','OLLAMA_CONTEXT_LENGTH':'4096','CUDA_VISIBLE_DEVICES':'-1','ROCR_VISIBLE_DEVICES':'-1','GGML_VK_VISIBLE_DEVICES':'-1','OLLAMA_LLM_LIBRARY':'cpu','OCEAN_QA_PHASE':str(phase),'OCEAN_QA_INSTALLED':str(installed)})
    capture=None
    if offline:
        capture=subprocess.Popen(['python3',str(P/'task-17.4-capture.py'),str(phase/'http-witness.jsonl')],env=env,close_fds=True)
        time.sleep(.2)
        if capture.poll() is not None: raise RuntimeError('passive witness failed')
    backend=None; result={'offline':offline,'driver':str(driver),'deadline':180,'providerDeadline':120,'metadataDeadline':10}
    try:
        backendLog=(phase/'backend.log').open('x'); backend=subprocess.Popen([str(Q/'backend/bin/ollama'),'serve'],env=env,stdout=backendLog,stderr=backendLog,close_fds=True)
        result['backendPidNamespace']=backend.pid; env['OCEAN_QA_BACKEND_PID']=str(backend.pid)
        for _ in range(200):
            if backend.poll() is not None: raise RuntimeError('backend exited before ready')
            try:
                with socket.create_connection(('127.0.0.1',11474),.1): break
            except OSError: time.sleep(.05)
        else: raise RuntimeError('backend readiness timeout')
        with driver.open('rb') as source,(phase/'driver.stdout').open('xb') as out,(phase/'driver.stderr').open('xb') as err:
            command=['node','--input-type=module']; result['command']=command; result['cwd']=str(installed)
            node=subprocess.Popen(command,cwd=installed,env=env,stdin=source,stdout=out,stderr=err,close_fds=True)
            try: result['driverExit']=node.wait(timeout=180)
            except subprocess.TimeoutExpired:
                node.terminate()
                try: node.wait(timeout=5)
                except subprocess.TimeoutExpired: node.kill(); node.wait(timeout=5)
                result['driverTimedOut']=True; result['driverExit']=node.returncode
    except Exception as error:
        result['error']=str(error); result['traceback']=traceback.format_exc()
    finally:
        if backend is not None:
            if backend.poll() is None: backend.terminate()
            try: result['backendExit']=backend.wait(timeout=10)
            except subprocess.TimeoutExpired: backend.kill(); result['backendExit']=backend.wait(timeout=5); result['backendKilled']=True
            backendLog.close()

        if capture is not None:
            capture.terminate(); result['captureExit']=capture.wait(timeout=3)
        closure={}
        for label,address in [('backend',('127.0.0.1',11474))]:
            try:
                with socket.create_connection(address,.2): closure[label]='still_open'
            except OSError: closure[label]='closed'
        result['listenersAfterBackendStop']=closure
        write(phase/'inner-result.json',result)
        (phase/'final-ready').touch(exist_ok=False)
        deadline=time.monotonic()+15
        while not (phase/'final-release').exists() and time.monotonic()<deadline: time.sleep(.05)
    sys.exit(0 if result.get('driverExit')==0 and 'error' not in result else 1)
name=sys.argv[1]; installed=pathlib.Path(sys.argv[2]); driver=pathlib.Path(sys.argv[3]).resolve(); offline=sys.argv[4]=='offline'
phase=Q/name; phase.mkdir(mode=0o700)
import shutil,hashlib
inputs=phase/'inputs'; inputs.mkdir(mode=0o700)
for source in [pathlib.Path(__file__).resolve(),P/'task-17.4-capture.py',P/'task-17.4-sparse.py',P/'task-17.4-identities.py',P/'task-17.4-scope.py',P/'task-17.4-location.json',driver]: shutil.copyfile(source,inputs/source.name)
driver=inputs/driver.name
write(inputs/'hashes.json',{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs.iterdir() if f.is_file()})
short=pathlib.Path(tempfile.mkdtemp(prefix='oa174-')); short.chmod(0o700)
nodeBin=str(pathlib.Path(shutil.which('node')).resolve().parent)
env={'PATH':nodeBin+':/usr/bin','LANG':'C.UTF-8'}
for key,sub in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_CACHE_HOME','cache'),('XDG_STATE_HOME','state')]:
    target=phase/sub; target.mkdir(mode=0o700); env[key]=str(target)
for key,sub in [('XDG_RUNTIME_DIR','run'),('TMPDIR','tmp')]:
    target=short/sub; target.mkdir(mode=0o700); env[key]=str(target)
unit='ocean-17-4-'+name+'-'+str(os.getpid()); outerNamespace=os.readlink('/proc/self/ns/net')
inner=['python3',str(inputs/pathlib.Path(__file__).name),'inner',str(phase),str(installed),str(driver),'offline' if offline else 'online']
if offline:
    import importlib.util
    spec=importlib.util.spec_from_file_location('sparse',inputs/'task-17.4-sparse.py');sparse=importlib.util.module_from_spec(spec);spec.loader.exec_module(sparse)
    setup="import os,subprocess,sys; subprocess.run(['ip','link','set','lo','up'],check=True,close_fds=True); os.execv('/usr/bin/bwrap',sys.argv[1:])"
    inner=['unshare','--user','--map-root-user','--net','--pid','--fork','--kill-child','python3','-c',setup,*sparse.sparse_command(Q,phase,installed,short,inner)]
command=['systemd-run','--user','--scope','--unit='+unit,'-p','CPUAccounting=yes','-p','MemoryAccounting=yes','-p','CPUQuota=200%','-p','MemoryHigh=3G','-p','MemoryMax=3584M','-p','MemorySwapMax=0','-p','TasksMax=256','timeout','--signal=TERM','--kill-after=10s','900s','env','-i',*[k+'='+v for k,v in env.items()],*inner]
scopeHelper=helper('scope');identityHelper=helper('identities');scopeHandle=None
outerSecurity={'uid':os.getuid(),**{line.split(':')[0]:line.split(':',1)[1].strip()for line in pathlib.Path('/proc/self/status').read_text().splitlines()if line.startswith(('CapEff','CapBnd','NoNewPrivs'))}}
policy=identityHelper.DRIVERS.get(driver.name)
if policy is None:raise ValueError('explicit phase identity policy required')
record={'outerSecurity':outerSecurity,'identityPolicy':policy,'argv':command,'outerNetns':outerNamespace,'driver':str(driver),'started':time.time()}; seen={}; cg=None
with (phase/'supervisor.log').open('x') as log,(phase/'samples.jsonl').open('x') as samples:
    child=subprocess.Popen(command,stdout=log,stderr=log,close_fds=True)
    deadline=time.monotonic()+920
    try:
        for _ in range(100):
            r=subprocess.run(['systemctl','--user','show',unit+'.scope','--property=ControlGroup','--value'],capture_output=True,text=True,timeout=2,close_fds=True)
            if r.returncode==0 and r.stdout.strip(): cg=pathlib.Path('/sys/fs/cgroup'+r.stdout.strip()); break
            if child.poll() is not None: raise RuntimeError('scope failed before admission')
            time.sleep(.05)
        if cg is None: raise RuntimeError('cgroup readiness timeout')
        scopeHandle=scopeHelper.capture(unit+'.scope',cg);record['scopeIdentity']=scopeHandle
        record['cgroup']=str(cg); initial=snapshot(cg); write(phase/'cgroup-initial.json',initial)
        controls=initial['cgroup']; assert controls['cpu.max']=='200000 100000' and controls['memory.max']=='3758096384' and controls['memory.high']=='3221225472' and controls['memory.swap.max']=='0' and controls['pids.max']=='256'
        while child.poll() is None:
            snap=snapshot(cg); samples.write(json.dumps(snap)+'\n'); samples.flush()
            for value in snap['processes']: seen[(value['pid'],value['starttime'])]=value
            if (phase/'final-ready').exists() and not (phase/'final-release').exists():
                write(phase/'cgroup-final.json',snap); (phase/'final-release').touch(exist_ok=False)
            if time.monotonic()>deadline: raise RuntimeError('outer supervisor timeout')
            time.sleep(.1)
        record['exit']=child.wait(timeout=2)
    except Exception as error:
        record['error']=str(error)
        record['exit']=child.poll()
# Retirement follows actual population even when the launcher has already exited.
record['scopeRetirement']=scopeHelper.retire(scopeHandle) if scopeHandle is not None else {'confirmed':False,'signals':[],'errors':['no verified scope identity']}
try:record['exit']=child.wait(timeout=3)
except subprocess.TimeoutExpired:record.setdefault('error','launcher did not reap after scope retirement')
record['scopeGone']=cg is not None and not cg.exists();record['scopeEmpty']=record['scopeRetirement']['confirmed'];record['remaining']=snapshot(cg) if cg is not None and cg.exists() else None
record['pidIdentitiesGone']=all(not (v:=proc(pid)) or v['starttime']!=start for pid,start in seen)
record['seenProcesses']=list(seen.values())
if (phase/'cgroup-final.json').exists():
    final=json.loads((phase/'cgroup-final.json').read_text()); events=final['cgroup']['memory.events'] or ''
    record['oomFree']=all(int(line.split()[1])==0 for line in events.splitlines() if line.split()[0] in ['oom','oom_kill','oom_group_kill'])
else: record['oomFree']=False
if (phase/'network.json').exists():
    network=json.loads((phase/'network.json').read_text());record['privateNetnsDifferent']=network['namespace']!=outerNamespace
    rows=[json.loads(line)for line in (phase/'samples.jsonl').read_text().splitlines()]
    record['identityValidation']=identityHelper.validate(rows,policy,network['namespace'],outerNamespace,outerSecurity)
    record['backendClientNamespacesMatch']=record['identityValidation']['ok']
else:record['identityValidation']={'ok':False,'errors':['missing network evidence']}
# The listening address is unreachable from the outer netns; retirement is proven by all recorded identities and cgroup emptiness.
import shutil
shutil.rmtree(short); record['shortFixtureRemoved']=not short.exists(); record['ended']=time.time()
write(phase/'supervisor-result.json',record); print(json.dumps(record,indent=2))
sys.exit(0 if 'error' not in record and record.get('exit')==0 and (record['scopeGone'] or record['scopeEmpty']) and record['pidIdentitiesGone'] and record['oomFree'] and record['scopeRetirement']['confirmed'] and record['identityValidation']['ok'] else 1)
