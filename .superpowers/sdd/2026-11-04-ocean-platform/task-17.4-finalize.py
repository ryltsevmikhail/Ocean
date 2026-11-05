"""Bounded supervisor finalization that preserves errors and independent PID evidence."""
import subprocess

def finish(record,handle,launcher,identities,retire,check,work_error=None):
    error=work_error
    try:record['scopeRetirement']=retire(handle)if handle is not None else{'confirmed':False,'signals':[],'errors':[{'type':'Unavailable','message':'no verified scope identity'}]}
    except Exception as failure:
        record['scopeRetirement']={'confirmed':False,'signals':[],'errors':[{'type':type(failure).__name__,'message':str(failure)}]};error=error or failure
    try:record['exit']=launcher.wait(timeout=3);record['launcherReaped']=True
    except Exception as failure:record['launcherReaped']=False;record['launcherWaitError']={'type':type(failure).__name__,'message':str(failure)};error=error or failure
    finally:
        try:record['pidIdentityCheck']=check(identities)
        except Exception as failure:record['pidIdentityCheck']={'confirmedGone':False,'observations':[],'error':type(failure).__name__};error=error or failure
        record['pidIdentitiesGone']=record['pidIdentityCheck']['confirmedGone']
    if not record['scopeRetirement']['confirmed']and error is None:error=RuntimeError('owned scope cleanup unconfirmed')
    if not record['pidIdentitiesGone']and error is None:error=RuntimeError('owned process identity disappearance unconfirmed')
    if error is not None:record.setdefault('error',str(error));record['originalErrorType']=type(error).__name__
    return error


def exit_code(record):
    good=('error'not in record and record.get('exit')==0 and(record.get('scopeGone')or record.get('scopeEmpty'))and record.get('pidIdentityCheck',{}).get('confirmedGone')is True and record.get('launcherReaped')is True and record.get('oomFree')is True and record.get('scopeRetirement',{}).get('confirmed')is True and record.get('identityValidation',{}).get('ok')is True)
    return 0 if good else 1

def complete(record,handle,launcher,identities,retire,check,diagnostics,writer,work_error=None):
    error=finish(record,handle,launcher,identities,retire,check,work_error)
    try:
        for name,diagnostic in diagnostics:
            try:diagnostic()
            except Exception as failure:
                record.setdefault('secondaryErrors',[]).append({'diagnostic':name,'type':type(failure).__name__,'message':str(failure)})
                if error is None:
                    error=failure;record.setdefault('error',str(failure));record['originalErrorType']=type(failure).__name__
    finally:
        status=exit_code(record)
        writer(record)
    return error,status
