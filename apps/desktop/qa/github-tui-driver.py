"""Task 6 TUI qualification driver: real built TUI in a 220x40 Linux PTY.

The owner runtime is started separately (github-runtime-host.mjs). This driver
types one addressed message that makes the deterministic provider call the
granted plugin tool, then runs `/plugin operations`, and reports the rendered
screen so the shared journal is visible without redesigning the TUI.
"""
import fcntl
import json
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

node, profile, room, report = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 220, 0, 0))


def attach_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


cli = subprocess.Popen(
    [node, "apps/cli/dist/main.js", "tui", "--profile", profile, "--room", room],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    preexec_fn=attach_terminal,
)
screen = bytearray()


def pump(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if cli.poll() is not None:
            break
        if select.select([master], [], [], 0.1)[0]:
            try:
                screen.extend(os.read(master, 65536))
            except OSError:
                break


def visible():
    text = screen.decode("utf8", "replace")
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    return re.sub(r"\x1b\][^\x07]*\x07", "", text)


try:
    pump(3.0)
    os.write(master, "@dev Прочитай issue #7 из team/api\r".encode())
    pump(9.0)
    os.write(master, "/plugin operations\r".encode())
    pump(5.0)
    text = visible()
    observed = "observed" in text and "issue_read" in text
    with open(report, "w", encoding="utf8") as handle:
        json.dump(
            {
                "observed": observed,
                "screenTail": [line for line in text.split("\n") if line.strip()][-16:],
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    print(json.dumps({"observed": observed}))
    sys.exit(0 if observed else 1)
finally:
    cli.send_signal(signal.SIGTERM)
    try:
        cli.wait(timeout=10)
    except subprocess.TimeoutExpired:
        cli.kill()
