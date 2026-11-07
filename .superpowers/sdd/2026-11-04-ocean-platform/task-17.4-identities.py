"""Phase contracts for every sampled backend, runner and Node identity."""
import re
RELEVANT={'ollama','llama-server','node','node-MainThread'}
REQUIRED={
    'native-offline':{'backend','runner','driver','cli-init','cli-history','binder'},
    'mixed-online':{'backend','runner','driver','cli-init'},
    'metadata-offline':{'backend','driver'},
    'owner-offline':{'backend','driver','cli-init'},
    'diagnostic-offline':{'backend','runner','driver'},
}
DRIVERS={'task-17.4-offline.txt':'native-offline','task-17.4-mixed.txt':'mixed-online','task-17.4-red.txt':'metadata-offline','task-17.4-metadata-green.txt':'metadata-offline','task-17.4-owner-preflight.txt':'owner-offline','task-17.4-tool-diagnostic.txt':'diagnostic-offline','task-17.4-raw-diagnostic.txt':'diagnostic-offline'}
def role(p):
    name,argv=p.get('name'),p.get('argv','')
    if name=='ollama' and '/backend/bin/ollama serve ' in argv:return 'backend'
    if name=='llama-server' and '/backend/lib/ollama/llama-server --model ' in argv:return 'runner'
    if name in {'node','node-MainThread'}:
        if '--input-type=module' in argv:return 'driver'
        if '/launch.js init ' in argv:return 'cli-init'
        if '/launch.js history ' in argv:return 'cli-history'
        if ' -e ' in argv and 'server.listen({ fd:' in argv and "process.once('disconnect'" in argv:return 'binder'
        return 'additional-node'
    return 'unrecognized'
def identity_key(p):
    pid,start=p.get('pid'),p.get('starttime')
    return (pid,start)if type(pid)is int and pid>0 and isinstance(start,str)and re.fullmatch('[1-9][0-9]*',start)else None

def fingerprint(p,policy):
    name=p.get('name');canonical='node'if isinstance(name,str)and name in {'node','node-MainThread'}else name
    return (canonical,p.get('argv'),p.get('netns'),p.get('CapEff'),p.get('CapBnd'),p.get('NoNewPrivs'),policy)

def validate(samples,policy,namespace,outer_namespace,outer_security):
    errors=[];identities={};roles=set();observations=0;fingerprints={};witnesses={}
    if policy not in REQUIRED:return {'ok':False,'errors':['unknown phase policy']}
    online=policy=='mixed-online'
    if not isinstance(namespace,str) or not re.fullmatch(r'net:\[\d+\]',namespace):errors.append('invalid namespace identity')
    if (namespace==outer_namespace)!=online:errors.append('namespace policy mismatch')
    if online and (type(outer_security.get('uid')) is not int or outer_security['uid']<=0 or outer_security.get('CapEff')!='0000000000000000' or outer_security.get('NoNewPrivs')!='0' or not re.fullmatch('[0-9a-f]{16}',outer_security.get('CapBnd',''))):errors.append('invalid trusted nonroot launch policy')
    recognized={}
    for row in samples:
        for p in row.get('processes',[]):
            name=p.get('name');key=identity_key(p)
            if isinstance(name,str)and name in RELEVANT and key is not None:recognized.setdefault(key,fingerprint(p,policy))
    for row in samples:
        # A PID cannot have two simultaneous incarnations, including an unrecognized row.
        related={}
        for p in row.get('processes',[]):
            key=identity_key(p);name=p.get('name')
            if key is not None and isinstance(name,str)and name in RELEVANT:related.setdefault(key[0],set()).add(key[1])
        # Check every record attached to a known witness before unrelated names are filtered.
        for p in row.get('processes',[]):
            key=identity_key(p);pid=p.get('pid')
            if type(pid)is int and pid in related and(key is None or key[1]not in related[pid]or len(related[pid])!=1):errors.append('contradictory shared PID in one observation')
            if key in recognized and fingerprint(p,policy)!=recognized[key]:errors.append(f'contradictory recognized identity {key[0]}:{key[1]}')
        row_pids={}
        for p in row.get('processes',[]):
            if not isinstance(p.get('name'),str)or p['name']not in RELEVANT:continue
            observations+=1;pid,start=p.get('pid'),p.get('starttime')
            if type(pid) is not int or pid<=0 or not isinstance(start,str) or not start.isdecimal() or not int(start)or str(int(start))!=start:errors.append('invalid PID/starttime');continue
            key=(pid,start);r=role(p);roles.add(r)
            if pid in row_pids and row_pids[pid]!=start:errors.append('contradictory same-observation PID starttime')
            row_pids[pid]=start
            value=fingerprint(p,policy)
            if key in fingerprints and fingerprints[key]!=value:errors.append(f'contradictory identity {pid}:{start}')
            fingerprints.setdefault(key,value);witnesses.setdefault(r,set()).add(key)
            identities.setdefault(key,{'pid':pid,'starttime':start,'name':p['name'],'roles':[]})
            if r not in identities[key]['roles']:identities[key]['roles'].append(r)
            if p.get('netns')!=namespace:errors.append(f'wrong namespace {pid}:{start}')
            eff='0000000000000000' if online else '0000000000002000'
            bnd=outer_security.get('CapBnd') if online else '0000000000002000'
            nnp='0' if online else '1'
            if p.get('CapEff')!=eff or p.get('CapBnd')!=bnd or p.get('NoNewPrivs')!=nnp:errors.append(f'wrong security policy {pid}:{start}')
            if r=='unrecognized':errors.append(f'unrecognized role {pid}:{start}')
    required=sorted(REQUIRED[policy])
    for index,left in enumerate(required):
        for right in required[index+1:]:
            if witnesses.get(left,set())&witnesses.get(right,set()):errors.append('separate process roles share an identity')
    missing=REQUIRED[policy]-roles
    if missing:errors.append('missing roles: '+','.join(sorted(missing)))
    return {'ok':not errors,'policy':policy,'namespace':namespace,'outerNamespace':outer_namespace,'trustedOuterSecurity':outer_security if online else None,'requiredRoles':sorted(REQUIRED[policy]),'observedRoles':sorted(roles),'relevantObservations':observations,'identities':list(identities.values()),'errors':sorted(set(errors))}
