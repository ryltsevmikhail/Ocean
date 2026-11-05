"""Descriptor-relative private directories and exclusive complete-byte publication."""
import os,pathlib,stat
FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW

def inspect(fd,private):
    s=os.fstat(fd)
    if not stat.S_ISDIR(s.st_mode)or s.st_uid not in ({os.getuid()}if private else{0,os.getuid()}):raise ValueError('untrusted directory descriptor')
    if (s.st_mode&0o077 if private else (s.st_mode&0o022 and not s.st_mode&0o1000)):raise ValueError('insecure directory descriptor')

def root_fd(root):
    root=pathlib.Path(root)
    if not root.is_absolute()or '..'in root.parts or str(root)!=os.path.normpath(root):raise ValueError('invalid trusted root')
    fd=os.open('/',FLAGS)
    try:
        inspect(fd,False)
        for name in root.parts[1:]:
            child=os.open(name,FLAGS,dir_fd=fd);os.close(fd);fd=child;inspect(fd,False)
        inspect(fd,True);return fd
    except BaseException:os.close(fd);raise

def descend(root,parts):
    fd=os.dup(root)
    try:
        inspect(fd,True)
        for name in parts:
            if name in {'','.','..'}or '/'in name:raise ValueError('invalid relative directory')
            child=os.open(name,FLAGS,dir_fd=fd);os.close(fd);fd=child;inspect(fd,True)
        return fd
    except BaseException:os.close(fd);raise

def exists(fd,name):
    try:os.stat(name,dir_fd=fd,follow_symlinks=False);return True
    except FileNotFoundError:return False

def publish(fd,name,data):
    if not isinstance(name,str)or name in {'','.','..'}or '/'in name:raise ValueError('invalid publication name')
    out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    with os.fdopen(out,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
