"""Observe the installed CLI on a real PTY; no source CLI import."""
import json
import pathlib
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

node, cli_entry, profile, room = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 140, 0, 0))
original = termios.tcgetattr(slave)
def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
cli = subprocess.Popen([node, cli_entry, 'tui', '--profile', profile, '--room', room], stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
screen = bytearray()
def until(pattern):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        found = re.search(pattern, screen)
        if found:
            return found.group().decode()
        if cli.poll() is not None:
            break
        if select.select([master], [], [], .1)[0]:
            screen.extend(os.read(master, 65536))
    raise AssertionError((pattern, screen[-1600:]))
try:
    until(b'@dev / ')
    inherited = dict(pair.split('=', 1) for pair in pathlib.Path('/proc/' + str(cli.pid) + '/environ').read_text().split('\0') if pair)
    selected = {key: inherited[key] for key in ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']}
    assert all(value == os.environ[key] for key, value in selected.items())
    assert 'DBUS_SESSION_BUS_ADDRESS' not in inherited
    pathlib.Path(profile).parent.joinpath('tui-environment.json').write_text(json.dumps({'pid': cli.pid, 'cli': cli_entry, 'env': selected}, indent=2))
    run = until(rb'tr_[a-zA-Z0-9_-]+(?= )')
    print('observing ' + run, flush=True)
    until(b'Test provider .*detach-turn')
    os.write(master, b'/quit\r')
    assert cli.wait(timeout=5) == 0
    assert termios.tcgetattr(slave) == original
    print(run)
finally:
    if cli.poll() is None:
        cli.kill()
        cli.wait()
    os.close(master)
    os.close(slave)
