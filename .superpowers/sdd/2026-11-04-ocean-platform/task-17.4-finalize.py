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
