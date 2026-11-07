"""Cooperative admission gate; no resistant orphan exists before owner admission."""
import json,os,pathlib,signal,sys,time
root=pathlib.Path(sys.argv[1]);signal.signal(signal.SIGALRM,signal.SIG_DFL);signal.alarm(8)
def record(name,value):
    temporary=root/(name+'.stage-'+str(os.getpid()))
    with temporary.open('x')as out:json.dump(value,out);out.flush();os.fsync(out.fileno())
    os.link(temporary,root/name);temporary.unlink()
def identity():return {'pid':os.getpid(),'starttime':pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]}
record('ready.json',identity());deadline=time.monotonic()+5
while not(root/'admit').exists():
    if time.monotonic()>deadline:sys.exit(2)
    time.sleep(.02)
pid=os.fork()
if pid:os._exit(0)
signal.alarm(6);signal.signal(signal.SIGTERM,signal.SIG_IGN)
record('orphan.json',{**identity(),'forkedAt':time.monotonic(),'safetyLifetimeSeconds':6})
while True:time.sleep(.05)
