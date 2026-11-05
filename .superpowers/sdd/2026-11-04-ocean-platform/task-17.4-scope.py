"""Retire one recorded owned transient cgroup, independent of launcher lifetime."""
import os,pathlib,re,subprocess,time

def properties(unit):
    r=subprocess.run(['systemctl','--user','show',unit,'--property=Id,ControlGroup,InvocationID'],capture_output=True,text=True,timeout=2,close_fds=True)
    if r.returncode:raise OSError('owned unit observation unavailable')
    return dict(line.split('=',1)for line in r.stdout.splitlines())
def verify(handle):
    unit,cg=handle['unit'],pathlib.Path(handle['cgroup']);uid=os.getuid()
    prefix=f'/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/'
    if handle['uid']!=uid or not re.fullmatch(r'ocean-17-4-[A-Za-z0-9_-]+\.scope',unit) or not str(cg).startswith(prefix) or cg.name!=unit or cg.resolve()!=cg:raise OSError('scope ownership mismatch')
    st=cg.stat();props=properties(unit)
    if (st.st_dev,st.st_ino)!=(handle['dev'],handle['ino']) or props.get('Id')!=unit or props.get('ControlGroup')!=str(cg).removeprefix('/sys/fs/cgroup') or props.get('InvocationID')!=handle['invocation'] or not re.fullmatch('[a-f0-9]{32}',handle['invocation']):raise OSError('scope identity changed')
    return cg

def capture(unit,cg):
    props=properties(unit);st=cg.stat();handle={'unit':unit,'cgroup':str(cg),'invocation':props.get('InvocationID'),'dev':st.st_dev,'ino':st.st_ino,'uid':os.getuid()}
    verify(handle);return handle

def observe(handle):
    cg=pathlib.Path(handle['cgroup'])
    try:cg.stat()
    except FileNotFoundError:return {'gone':True,'populated':False,'procs':[]}
    st=cg.stat()
    if (st.st_dev,st.st_ino)!=(handle['dev'],handle['ino']):raise OSError('scope identity changed')
    try:events=dict(line.split()for line in (cg/'cgroup.events').read_text().splitlines());procs=(cg/'cgroup.procs').read_text().split()
    except FileNotFoundError:
        if not cg.exists():return {'gone':True,'populated':False,'procs':[]}
        raise
    if events.get('populated')not in {'0','1'} or any(not p.isdecimal()for p in procs) or (events['populated']=='0' and procs):raise OSError('cgroup population unavailable or inconsistent')
    return {'gone':False,'populated':events['populated']=='1','procs':list(map(int,procs))}

def retire(handle,term_seconds=10,kill_seconds=5,observe=observe):
    result={'confirmed':False,'signals':[],'observations':[],'errors':[]}
    def read():
        value=observe(handle);result['observations'].append({'monotonic':time.monotonic(),**value});return value
    def empty(value):return value['gone'] or (not value['populated'] and not value['procs'])
    try:
        current=read()
        if empty(current):result['confirmed']=True;return result
        for signal,grace in [('TERM',term_seconds),('KILL',kill_seconds)]:
            verify(handle) # Never signal by PID, stale unit name, or unverified cgroup.
            command=['systemctl','--user','kill','--kill-whom=all','--signal='+signal,handle['unit']]
            r=subprocess.run(command,capture_output=True,text=True,timeout=3,close_fds=True)
            result['signals'].append({'signal':signal,'argv':command,'exit':r.returncode})
            deadline=time.monotonic()+grace
            while True:
                current=read()
                if empty(current):result['confirmed']=True;return result
                if time.monotonic()>=deadline:break
                time.sleep(.03)
        result['errors'].append('owned cgroup remained populated after KILL deadline')
    except OSError as error:result['errors'].append(str(error))
    return result
