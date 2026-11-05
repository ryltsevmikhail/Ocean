"""Installed CLI, real PTY, ACP stdio and Python3 Unix socket offline qualification."""
import hashlib,json,os,pathlib,select,socket,subprocess,sys,time
ROOT=pathlib.Path(sys.argv[1]);SOURCE=ROOT/'source';entry=ROOT/'prefix/lib/ocean/releases/1.1.0-rc.3/launch.js';main=entry.parent/'apps/cli/dist/main.js';node=pathlib.Path(subprocess.check_output(['which','node'],text=True).strip())
root=ROOT/'hosts-rehearsal';root.mkdir(mode=0o700);profile=root/'profile';workspace=root/'workspace';workspace.mkdir(mode=0o700);ledger=[]
def run(*args,codes=(0,)):
    r=subprocess.run([str(node),str(entry),*map(str,args),'--profile',str(profile),'--json'],capture_output=True,text=True,timeout=30)
    ledger.append({'args':list(map(str,args)),'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr});assert r.returncode in codes,(r.returncode,r.stdout,r.stderr);return json.loads(r.stdout)
run('init','--workspace',workspace);run('bot','add','--handle','dev','--name','Dev','--role','Synthetic offline');run('bot','add','--handle','review','--name','Review','--role','Synthetic offline');room=run('room','direct','--bot','dev')['data']['data']['id'];group=run('room','group','--name','Synthetic Team','--bot','dev','--bot','review')['data']['data']['id'];assert len(run('room','list')['data'])==2
assert run('send',room,'--text','no credential',codes=(4,))['error']['code']=='provider_unavailable';assert run('doctor')['data']['permissions'] is True
requests=root/'requests';env=dict(os.environ,DEEPSEEK_API_KEY='fixture-only',OCEAN_TEST_LOG=str(requests));owner=subprocess.Popen([str(node),'--import',str(SOURCE/'apps/desktop/qa/provider.mjs'),str(entry),'runtime','start','--profile',str(profile),'--json'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
owner_output=[];children=[]
buffers={}
def line(p,timeout=20):
    fd=p.stdout.fileno();pending=buffers.get(fd,b'');deadline=time.monotonic()+timeout
    while b'\n' not in pending:
        assert select.select([fd],[],[],max(0,deadline-time.monotonic()))[0], 'child output timeout'
        chunk=os.read(fd,65536);assert chunk,(p.poll(),'child closed');pending+=chunk
    head,pending=pending.split(b'\n',1);buffers[fd]=pending;return head.decode()+'\n'

try:
    ready=json.loads(line(owner));assert ready['data']['state']=='ready';owner_output.append(ready)
    descriptors=list(pathlib.Path(os.environ['XDG_RUNTIME_DIR']).rglob('connection.json'));assert len(descriptors)==1
    d=json.loads(descriptors[0].read_text())
    def connect():
        s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect(d['endpoint']);return s,s.makefile('rb')
    def rpc(s,f,id,method,params):
        s.sendall((json.dumps({'id':id,'method':method,'params':params})+'\n').encode());return json.loads(f.readline())
    hello={k:d[k] for k in ['protocol','profileId','instanceId','capability']}
    with_socket=[]
    for mode in ['unauthenticated','wrong-capability','authenticated']:
        s,f=connect()
        try:
            if mode=='unauthenticated':assert rpc(s,f,'a','status',{})['error']['code']=='authentication_required'
            elif mode=='wrong-capability':assert rpc(s,f,'b','hello',{**hello,'capability':'0'*64})['error']['code']=='authentication_failed'
            else:
                identity=rpc(s,f,'c','hello',hello)['result'];assert identity['instanceId']==ready['data']['instanceId'];assert rpc(s,f,'d','status',{})['result']['state']=='ready';rooms=rpc(s,f,'e','rooms.list',{'workspaceId':'ws_ocean'})['result'];assert len(rooms)==2
            with_socket.append(mode)
        finally:f.close();s.close()
    send=subprocess.Popen([str(node),str(entry),'send',room,'--text','detach-turn','--profile',str(profile),'--json'],env=os.environ,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);children.append(send)
    deadline=time.monotonic()+20
    while not requests.exists():assert time.monotonic()<deadline;time.sleep(.02)
    tui=subprocess.Popen(['python3',str(SOURCE/'apps/desktop/qa/installed-tui.py'),str(node),str(main),str(profile),room],env=os.environ,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);children.append(tui)
    observing=line(tui);assert observing.startswith('observing tr_')
    requests.with_suffix('.release').write_text('release')
    stdout,stderr=tui.communicate(timeout=20);assert tui.returncode==0,stderr
    sendout,senderr=send.communicate(timeout=20);assert send.returncode==0,senderr;turn=json.loads(sendout)['data'];assert turn['status']=='admitted'
    history=run('history',room)['data'];assert history[-1]['body']=='Test provider · detach-turn';assert requests.read_text().count('\n')==1
    assert run('runtime','status')['data']['instanceId']==ready['data']['instanceId'];assert run('runtime','stop')['data']['outcome']=='complete';assert owner.wait(timeout=10)==0
    # ACP is a separate installed stdio host with deterministic no-provider turns.
    acp=subprocess.Popen([str(node),str(entry),'acp'],env=os.environ,cwd=workspace,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);children.append(acp);frames=[]
    def acprpc(id,method,params):
        acp.stdin.write(json.dumps({'jsonrpc':'2.0','id':id,'method':method,'params':params})+'\n');acp.stdin.flush()
        while True:
            frame=json.loads(line(acp));frames.append(frame)
            if frame.get('id')==id:assert 'error' not in frame,frame;return frame['result']
    initialized=acprpc(1,'initialize',{'protocolVersion':1,'clientCapabilities':{}});assert initialized['protocolVersion']==1
    session=acprpc(2,'session/new',{'cwd':str(workspace),'mcpServers':[]});prompt=acprpc(3,'session/prompt',{'sessionId':session['sessionId'],'prompt':[{'type':'text','text':'offline deterministic turn'}]});assert prompt['stopReason']=='end_turn'
    acp.stdin.close();assert acp.wait(timeout=10)==0
    proof={'installedEntry':str(entry),'node':str(node),'python':sys.version,'cliRooms':2,'offlineUnavailable':True,'doctorPermissions':True,'socket':{'pythonAF_UNIX':True,'authenticationRequired':True,'wrongCapabilityRefused':True,'authenticatedStatusAndRooms':True,'sameOwnerIdentity':True},'tui':{'helper':str(SOURCE/'apps/desktop/qa/installed-tui.py'),'observing':observing.strip(),'exit':tui.returncode,'terminalRestored':True,'providerDispatches':1},'acp':{'initialize':initialized,'session':session,'prompt':prompt,'frames':frames,'exit':acp.returncode},'ownerExit':owner.returncode}
    (ROOT/'hosts-proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof,indent=2))
finally:
    for p in children+[owner]:
        if p.poll() is None:p.kill();p.wait(timeout=10)
    (root/'commands.json').write_text(json.dumps(ledger,indent=2)+'\n')
