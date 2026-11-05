"""Direct stat-only process identity proof; unavailable is never disappearance."""
import errno,pathlib

def observe(pid,starttime):
    result={'pid':pid,'starttime':starttime,'state':'unavailable'}
    if type(pid)is not int or pid<=0 or not isinstance(starttime,str) or not starttime.isdecimal() or int(starttime)<=0 or str(int(starttime))!=starttime:
        return {**result,'reason':'invalid expected identity'}
    try:
        text=pathlib.Path('/proc',str(pid),'stat').read_text()
        close=text.rfind(')')
        opening=text.find('(')
        if opening<0 or close<=opening or text[:opening].strip()!=str(pid):raise ValueError('malformed proc stat identity')
        fields=text[close+1:].split()if close>=0 else[]
        if len(fields)<20 or not fields[19].isdecimal() or int(fields[19])<=0:raise ValueError('malformed proc stat')
        actual=fields[19]
        return {**result,'state':'present'if actual==starttime else'gone','observedStarttime':actual,'reason':'same identity'if actual==starttime else'PID reused'}
    except OSError as error:
        return {**result,'state':'gone'if error.errno in {errno.ENOENT,errno.ESRCH}else'unavailable','reason':type(error).__name__,'errno':error.errno}
    except(ValueError,IndexError)as error:return {**result,'reason':str(error)}

def check(identities):
    values=[observe(pid,start)for pid,start in identities]
    return {'confirmedGone':bool(values)and all(v['state']=='gone'for v in values),'observations':values}
