"""Installed TUI submits one held turn on a real PTY, then explicitly detaches."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

node, cli_entry, profile, room, root = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 140, 0, 0))
original = termios.tcgetattr(slave)

def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

cli = subprocess.Popen([node, cli_entry, 'tui', '--profile', profile, '--room', room],
                       stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
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
    until(b'@bot001 / ')
    stat = pathlib.Path('/proc/' + str(cli.pid) + '/stat').read_text()
    start = stat[stat.rindex(')') + 2:].split()[19]
    inherited = dict(pair.split('=', 1) for pair in pathlib.Path('/proc/' + str(cli.pid) + '/environ').read_text().split('\0') if pair)
    selected = {key: inherited[key] for key in ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']}
    assert all(value == os.environ[key] for key, value in selected.items())
    os.write(master, b'held-tui\r')
    until(b'held-tui')
    until(rb'tr_[a-zA-Z0-9_-]+(?= )')
    # Parent verifies the actual provider dispatch and authoritative running state first.
    pathlib.Path(root, 'tui-ready').write_text('ready')
    deadline = time.monotonic() + 30
    while not pathlib.Path(root, 'tui-detach').exists():
        assert time.monotonic() < deadline
        time.sleep(.05)
    os.write(master, b'/quit\r')
    assert cli.wait(timeout=5) == 0
    assert termios.tcgetattr(slave) == original
    pathlib.Path(root, 'tui.json').write_text(json.dumps({
        'pid': cli.pid, 'startTime': start, 'cli': cli_entry, 'env': selected,
        'exit': cli.returncode, 'terminalRestored': True,
        'screen': screen.decode('utf8', 'replace')}, indent=2))
finally:
    if cli.poll() is None:
        cli.kill()
        cli.wait()
    os.close(master)
    os.close(slave)
