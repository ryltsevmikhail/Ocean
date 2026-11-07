"""Offline-only passive loopback HTTP witness; retains settings/counts, never prompts."""
import socket,struct,sys,pathlib,json,time,signal,io,http.client
out=pathlib.Path(sys.argv[1]); stop=False; streams={}
def end(*_):
    global stop
    stop=True
signal.signal(signal.SIGTERM,end)
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3));s.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4*1024*1024);s.bind(('lo',0));s.settimeout(.2)
def record(value):
    with out.open('a') as f:f.write(json.dumps({'monotonic':time.monotonic(),**value})+'\n')
record({'capture':'ready','netns':__import__('os').readlink('/proc/self/ns/net')})
while not stop:
    try:
        frame,ancillary,flags,address=s.recvmsg(262144)
        if flags & socket.MSG_TRUNC:record({'truncated':True});raise RuntimeError('packet truncated')
    except socket.timeout: continue
    if address[2]!=4 or frame[12:14]!=b'\x08\x00':continue
    ip=frame[14:14+struct.unpack('!H',frame[16:18])[0]];ihl=(ip[0]&15)*4
    if ip[9]!=6:continue
    tcp=ip[ihl:];src,dst,seq=struct.unpack('!HHI',tcp[:8]);offset=(tcp[12]>>4)*4;data=tcp[offset:]
    if 11474 not in (src,dst) or not data:continue
    key=(src,dst)
    if src==11474 and key not in streams:continue
    stream=streams.setdefault(key,{'next':seq,'buffer':b''})
    if stream['next'] is None:stream['next']=seq
    if seq>stream['next']:record({'gap':True,'src':src,'dst':dst,'expected':stream['next'],'actual':seq});continue
    overlap=stream['next']-seq
    if overlap>=len(data):continue
    data=data[overlap:];stream['next']+=len(data);stream['buffer']+=data
    while b'\r\n\r\n' in stream['buffer']:
        header,body=stream['buffer'].split(b'\r\n\r\n',1);lines=header.split(b'\r\n');fields={}
        for line in lines[1:]:
            if b':' in line:k,v=line.split(b':',1);fields[k.lower()]=v.strip()
        if fields.get(b'transfer-encoding')==b'chunked':
            pos=0;chunks=[]
            try:
                while True:
                    e=body.index(b'\r\n',pos);n=int(body[pos:e].split(b';')[0],16);pos=e+2
                    if len(body)<pos+n+2:raise ValueError()
                    chunks.append(body[pos:pos+n]);pos+=n+2
                    if n==0:break
            except ValueError:break
            consumed=pos;decoded=b''.join(chunks)
        else:
            n=int(fields.get(b'content-length',b'0'))
            if len(body)<n:break
            decoded=body[:n];consumed=n
        stream['buffer']=body[consumed:]
        first=lines[0].decode('ascii','replace');r={'src':src,'dst':dst,'line':first,'bodyBytes':len(decoded)}
        if dst==11474:
            if first.startswith('POST /api/chat '):streams[(11474,src)]={'next':None,'buffer':b''}
            try:
                value=json.loads(decoded)
                r.update({k:value[k] for k in ['model','think','stream','options'] if k in value})
                r['toolNames']=[t.get('function',{}).get('name') for t in value.get('tools',[])]
                r['roles']=[m['role'] for m in value.get('messages',[])]
            except (ValueError,KeyError):pass
        else:
            for line in decoded.splitlines():
                if b'"done"' not in line:continue
                try:value=json.loads(line)
                except ValueError:continue
                r.setdefault('nativeRecords',[]).append(value)
                if value.get('done') is True:r['terminal']={k:value[k] for k in ['model','done','done_reason','total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration'] if k in value}
        record(r)
        if src==11474:del streams[key];break
record({'incompleteResponseStreams':[{'src':key[0],'dst':key[1],'bytes':len(value['buffer'])} for key,value in streams.items() if key[0]==11474]})
packets,drops=struct.unpack('II',s.getsockopt(263,6,8));record({'kernelPackets':packets,'kernelDrops':drops});s.close();record({'capture':'stopped'});assert drops==0,'packet drops'
