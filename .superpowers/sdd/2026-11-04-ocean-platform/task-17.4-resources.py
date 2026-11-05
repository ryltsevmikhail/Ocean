"""Summarize observed cgroup accounting separately from sampled process RSS/PSS."""
import json,pathlib,sys,os,stat,argparse
P=pathlib.Path(__file__).resolve().parent;Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root'])
def pairs(text):return {line.split()[0]:int(line.split()[1]) for line in (text or '').splitlines()}
def number(v):return int(v) if v is not None and str(v).isdigit() else None
def kib(v):return int(v.split()[0])*1024 if v is not None else None

def summarize(root):
    summaries={}
    for phase in sorted(root.iterdir()):
        if not (phase/'samples.jsonl').exists():continue
        rows=[json.loads(line) for line in (phase/'samples.jsonl').read_text().splitlines()]
        initial=json.loads((phase/'cgroup-initial.json').read_text());final=json.loads((phase/'cgroup-final.json').read_text()) if (phase/'cgroup-final.json').exists() else rows[-1];processes={};rssMax=pssMax=0
        for row in rows:
            rss=pss=0
            for p in row['processes']:
                key=str(p['pid'])+':'+p['starttime'];record=processes.setdefault(key,{'pid':p['pid'],'starttime':p['starttime'],'name':p['name'],'argv':p.get('argv'),'netns':p['netns'],'maxSampledVmRSS':None,'maxObservedVmHWM':None,'maxSampledVmSwap':None,'maxSampledPss':None})
                for field,source in [('maxSampledVmRSS','VmRSS'),('maxObservedVmHWM','VmHWM'),('maxSampledVmSwap','VmSwap'),('maxSampledPss','Pss')]:
                    value=kib(p.get(source))
                    if value is not None:record[field]=max(record[field] or 0,value)
                rss+=kib(p.get('VmRSS')) or 0;pss+=kib(p.get('Pss')) or 0
            rssMax=max(rssMax,rss);pssMax=max(pssMax,pss)
        cg=final['cgroup'];before=pairs(initial['cgroup']['cpu.stat']);after=pairs(cg['cpu.stat'])
        summaries[phase.name]={'sampleCount':len(rows),'samplingNominalMs':100,'maxObservedSampleIntervalMs':max((b['monotonic']-a['monotonic'])*1000 for a,b in zip(rows,rows[1:])) if len(rows)>1 else None,'observedDurationSeconds':rows[-1]['monotonic']-rows[0]['monotonic'],'chargedMemoryPeakKernel':number(cg['memory.peak']),'chargedMemoryFinal':number(cg['memory.current']),'swapPeakKernel':number(cg['memory.swap.peak']),'swapMaxSampled':max(number(r['cgroup']['memory.swap.current']) or 0 for r in rows),'memoryEvents':pairs(cg['memory.events']),'cpuDeltaUsec':{k:after[k]-before.get(k,0) for k in ['usage_usec','user_usec','system_usec'] if k in after},'pidsMaxSampled':max(number(r['cgroup']['pids.current']) or 0 for r in rows),'simultaneousRSSMaxSampled':rssMax,'simultaneousPSSMaxSampled':pssMax,'processes':list(processes.values()),'cleanup':json.loads((phase/'supervisor-result.json').read_text())}
    return summaries

def destination(root,output):
    target=root/'resources-summary.json' if output is None else pathlib.Path(output)
    if not target.is_absolute() or '..' in target.parts or str(target)!=os.path.normpath(target):raise ValueError('invalid output path')
    if output is not None:
        try:target.relative_to(root/'fix1')
        except ValueError:raise ValueError('output outside owned follow-up root')from None
    try:parts=target.parent.relative_to(root).parts
    except ValueError:raise ValueError('output outside owned root')from None
    current=root
    for part in ('',*parts):
        if part:current=current/part
        info=current.lstat()
        if not stat.S_ISDIR(info.st_mode) or current.resolve()!=current or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('insecure output ancestry')
    return target

def publish(root,output=None):
    root=pathlib.Path(root);target=destination(root,output)
    directory=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        held=os.fstat(directory);current=target.parent.lstat()
        if (held.st_dev,held.st_ino)!=(current.st_dev,current.st_ino):raise ValueError('output parent changed')
        fd=os.open(target.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
        with os.fdopen(fd,'w')as out:
            summaries=summarize(root);json.dump(summaries,out,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())
        return summaries
    finally:os.close(directory)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path);args=parser.parse_args()
    result=publish(Q,args.output)
    for name,r in result.items():print(name,json.dumps({k:v for k,v in r.items()if k not in ['processes','cleanup']}))
