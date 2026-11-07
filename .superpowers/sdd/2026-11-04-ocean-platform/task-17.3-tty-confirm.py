"""Real stdin/stderr TTY for the installed owner's exact rebind card."""
import fcntl,json,os,pathlib,pty,select,struct,subprocess,sys,termios,time
node,entry,profile,config,root=sys.argv[1:]
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,140,0,0));original=termios.tcgetattr(slave)
def terminal():
    os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
p=subprocess.Popen([node,entry,'rebind','confirm','--profile',profile,'--config',config,'--json'],stdin=slave,stdout=subprocess.PIPE,stderr=slave,preexec_fn=terminal,text=True)
screen=bytearray()
try:
    deadline=time.monotonic()+20
    while b'Bind this exact restored tree, policy and new epoch? [y/N]' not in screen:
        assert time.monotonic()<deadline and p.poll() is None,screen[-1600:]
        if select.select([master],[],[],.1)[0]:screen.extend(os.read(master,65536))
    os.write(master,b'y\r');out=p.communicate(timeout=15)[0]
    assert p.returncode==0,out
    assert json.loads(out)['data']['status']=='allowed'
    assert termios.tcgetattr(slave)==original
    pathlib.Path(root,'tty-confirm.json').write_text(json.dumps({'argv':p.args,'exit':p.returncode,'stdinIsRealTTY':True,'stderrIsRealTTY':True,'terminalRestored':True,'stdout':json.loads(out),'preview':screen.decode(errors='replace')},indent=2)+'\n')
    print(out,end='')
finally:
    if p.poll() is None:p.kill();p.wait()
    os.close(master);os.close(slave)
