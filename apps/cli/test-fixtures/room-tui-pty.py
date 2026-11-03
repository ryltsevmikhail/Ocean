"""Drive the built standard room CLI using a real Linux PTY and isolated environment."""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, profile, room, action = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 140, 0, 0))
original = termios.tcgetattr(slave)

def attach_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


cli = subprocess.Popen([node, "apps/cli/dist/main.js", "tui", "--profile", profile,
                        "--room", room], stdin=slave, stdout=slave, stderr=subprocess.PIPE if action == 'hangup' else slave, preexec_fn=attach_terminal)
screen = bytearray()


def until(pattern):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        found = re.search(pattern, screen)
        if found:
            return found.group().decode()
        if cli.poll() is not None or not select.select([master], [], [], 0.1)[0]:
            if cli.poll() is not None:
                break
            continue
        screen.extend(os.read(master, 65536))
    raise AssertionError("terminal missing %r: %r" % (pattern, screen[-1600:]))


try:
    until(b"@dev / " if action == "desktop" else b"@dev / test")
    if action in ("sigterm", "hangup"):
        os.write(master, b"from the terminal\r")
        run_id = until(rb"tr_[a-zA-Z0-9_-]+(?= )")
        if action == "hangup":
            os.close(master)
            master = None
        else:
            os.kill(cli.pid, signal.SIGTERM)
    else:
        run_id = until(rb"tr_[a-zA-Z0-9_-]+(?= )")
        if action == "desktop":
            print("observing " + run_id, flush=True)
            until(b"Test provider .*detach-turn")
        else:
            until(b"native fixture answer")
        os.write(master, b"/quit\r")
    status = cli.wait(timeout=3)
    assert status == 0, (status, cli.stderr.read() if cli.stderr else screen[-500:])
    if master is not None:
        assert termios.tcgetattr(slave) == original, "terminal mode was not restored"
    print(run_id)
finally:
    if cli.poll() is None:
        cli.kill()
        cli.wait()
    if master is not None:
        os.close(master)
    os.close(slave)
